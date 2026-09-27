# Maintaining the Hugging Face dataset

Target: `hranesscom/sys1-benchmarks`, repository type `dataset`.
The source of truth is this Git repository. `README.md` in this directory is the
dataset card; `manifest.json` is the explicit source/destination/checksum list.
`stage.py` uses Python's standard library and performs no network or inference.

## Prepare an update

1. Add a dated, public synthetic benchmark report through the repository's
   normal review and checks. Preserve earlier files, failures, fixture versions,
   model/runtime identities, exposure, and timing boundaries. A new fixture
   requires a new identity. Never relabel a development set as unseen.
2. Review the exact content and redistribution terms before adding it to
   `manifest.json`. Keep provider credentials, user inputs, model-store files,
   incomplete authentication responses, and external JevBench data out. The
   current export intentionally omits the incomplete Jev attempt, the separate
   exploratory reasoning subset, and the module-proof artifact.
3. Add explicit paths and SHA-256 values. Do not glob `site/data/` or export a
   workspace. A changed checksum requires reviewing the changed bytes. Update
   the card alongside a new study and retain its limitations.
4. Run `python3 -B hf/stage.py` and `python3 -B hf/test_stage.py`, then the
   repository gate `bun run check`. Commit and integrate the reviewed changes.
5. From the clean integrated checkout, stage to a new directory outside it:

   ```sh
   python3 -B hf/stage.py --output /tmp/sys1-hf-reviewed-export
   ```

   Choose another new directory for subsequent updates. Inspect the card and
   manifest, compare them with the last Hub revision, and preserve history.
   `rights_status: reviewed-existing-mit` records review of the listed public
   synthetic fixtures, responses, and MIT license. Review redistribution rights
   separately for future additions. Staging is not public-upload authorization.

## Publish the reviewed export

Use the supported Hugging Face `hf` CLI in an authenticated environment. The
reviewed command version is `huggingface-hub==2.0.0`, invoked through
`uvx --from huggingface-hub==2.0.0 hf`. Check its `--help`, `auth whoami`, and
`upload --help` before use; this checkout
does not install the CLI, create tokens, or configure credentials. Confirm the
account can write to the `hranesscom` organization and that the destination is
the dataset above. Keep authentication material outside the repository and logs.

On 2026-09-27, Ben approved the exact initial public card and file set and granted
standing authority for routine reviewed synchronization to the existing
`hranesscom/sys1-benchmarks` dataset. The initial publication is
[Hub revision 6f11134bba12c0d8f8a211c19ef69203d167d384](https://huggingface.co/datasets/hranesscom/sys1-benchmarks/commit/6f11134bba12c0d8f8a211c19ef69203d167d384).
Agents may publish future updates within this scope after the source review,
required checks, rights review, staging comparison, and identity checks above.
Preserve immutable study history, license notices, and the verification below.
This authority excludes new destinations, private data, and paid resources.
A completed local stage alone never grants broader authority.
Upload the reviewed stage:

```sh
uvx --from huggingface-hub==2.0.0 hf auth whoami
uvx --from huggingface-hub==2.0.0 hf upload hranesscom/sys1-benchmarks \
  /tmp/sys1-hf-reviewed-export . --repo-type dataset --revision main \
  --commit-message "Sync reviewed Sys1 benchmark export"
```

The CLI has no dry-run flag; local validation and the reviewed file comparison
provide that check. `--create-pr` is available when a Hub review branch is needed.
Do not upload the Git checkout. Do not delete remote files or overwrite an
existing study with new observations. Coordinate one publisher and recheck the
observed remote revision immediately before writing. If it changed, compare and
restage before proceeding. Reconcile an uncertain upload before retrying.

Record the resulting Hub commit URL with the source commit and manifest digest.
Read the card and downloaded manifest back from that revision, compare all file
hashes, and check the canonical `https://sys1.io` link. No weight download,
provider run, new benchmark, or product release is required by dataset sync.

## Copy record

Dataset card and runbook drafted by the Codex SYS1 Hugging Face worker and
reviewed by the independent Codex integration owner. The same review confirmed
the listed files fall under the existing repository MIT license. Ben's public
content approval and the initial publication are recorded above; source review
and publication verification remain separate evidence.
