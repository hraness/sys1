"""Reconstruct the frozen payload from anonymous public bytes; explicit network opt-in."""
import datetime
import hashlib
import json
import pathlib
import subprocess
import sys
import tempfile
import urllib.request

if sys.argv[1:] != ["--download-public"]:
    raise SystemExit("Usage: python3 verify-public.py --download-public (anonymous network reads)")

base = pathlib.Path(__file__).resolve().parent
manifest = json.loads((base / "manifest.json").read_text())
fixtures = [json.loads(line) for name in ["fixtures.jsonl", "diagnostics.jsonl"]
            for line in (base / name).read_text().splitlines()]
sha = lambda value: hashlib.sha256(value).hexdigest()
assert sha((base / "fixtures.jsonl").read_bytes()) == manifest["fixtures_sha256"]
assert sha((base / "diagnostics.jsonl").read_bytes()) == manifest["diagnostics_sha256"]
public, receipts, verified = {}, [], []

def get_blob(repository, commit, path, expected):
    assert repository in {"hraness/sys1", "hraness/ghostget", "hraness/design-kit", "hraness/wordcell", "hraness/slopcamera"}
    assert len(commit) == 40 and all(c in "0123456789abcdef" for c in commit)
    assert not path.startswith("/") and ".." not in pathlib.PurePosixPath(path).parts
    key = (repository, commit, path)
    if key not in public:
        url = "https://raw.githubusercontent.com/" + "/".join(key)
        request = urllib.request.Request(url, headers={"User-Agent": "sys1-frozen-controls-provenance"})
        with urllib.request.urlopen(request, timeout=20) as response:
            assert response.status == 200 and response.url == url
            data = response.read(262_145)
        assert len(data) <= 262_144
        public[key] = data
        receipts.append({"url": url, "unauthenticated": True, "status": 200,
                         "sha256": sha(data), "bytes": len(data)})
    assert sha(public[key]) == expected, key
    return public[key]

for unit, fixture in zip(manifest["units"] + manifest["diagnostics"], fixtures, strict=True):
    state = ""
    for section in unit["sections"]:
        path = section["path"]
        blob = get_blob(unit["repository"], unit["commit"], path, section["blob_sha256"])
        if unit["representation"] == "snapshot-as-additions":
            lines = blob.decode("utf8").split("\n")[section["start"] - 1:section["end"]]
            assert sha(("\n".join(lines) + "\n").encode()) == section["excerpt_sha256"]
            state += (f"diff --git a/{path} b/{path}\n--- /dev/null\n+++ b/{path}\n"
                      f"@@ -0,0 +{section['start']},{len(lines)} @@\n"
                      + "".join("+" + line + "\n" for line in lines))
        else:
            before = get_blob(unit["repository"], unit["parent"], path, section["parent_blob_sha256"])
            with tempfile.TemporaryDirectory(prefix="sys1-public-diff-") as temporary:
                directory = pathlib.Path(temporary)
                for prefix, data in [("before", before), ("after", blob)]:
                    destination = directory / prefix / path
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(data)
                result = subprocess.run(["git", "-c", "core.autocrlf=false", "-c", "core.abbrev=7",
                    "diff", "--no-index", "--no-ext-diff", "--no-textconv", f"--unified={unit['unified']}",
                    "--", f"before/{path}", f"after/{path}"], cwd=directory,
                    capture_output=True, text=True, check=False)
                assert result.returncode == 1, "Expected a nonempty public diff"
                for line in result.stdout.splitlines(keepends=True):
                    if line.startswith("diff --git "):
                        line = f"diff --git a/{path} b/{path}\n"
                    elif line.startswith("--- a/before/"):
                        line = f"--- a/{path}\n"
                    elif line.startswith("+++ b/after/"):
                        line = f"+++ b/{path}\n"
                    state += line
    assert state == fixture["state"] and sha(state.encode()) == unit["state_sha256"], unit["id"]
    verified.append({"id": unit["id"], "state_sha256": unit["state_sha256"]})

report = {"verified_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
          "sources": receipts, "payloads_reconstructed_from_anonymous_public_bytes": verified,
          "model_destination": "https://api.typesafe.ai/v1/systemone", "model": "jev-1.13.0",
          "maximum_model_requests": 12,
          "payload_scope": "Only frozen public source/diff bytes and the unchanged public candidate-rule questions; no local paths, credentials, environment or uncommitted worktree source."}
(base / "public-payload.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({"anonymous_sources": len(receipts), "verified_payloads": len(verified), "model_requests": 0}))
