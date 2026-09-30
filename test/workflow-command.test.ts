import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorkflowCommand } from "../src/workflows/command.ts";
import { expireLogs } from "../src/workflows/files.ts";
import { WORKFLOW_LIMITS } from "../src/workflows/types.ts";

const roots: string[] = [];
// Command execution needs the process-group guarantees provided on these hosts.
const commandTest = test.skipIf(process.platform !== "darwin" && process.platform !== "linux");
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "sys1-workflow-command-")); roots.push(root);
  return { root, cwd: root, logDirectory: join(root, "logs"), timeoutMs: 3_000 };
}
describe("workflow command custody", () => {
  commandTest("preserves status, drains both pipes, and bounds private logs", async () => {
    const f = await fixture();
    const result = await runWorkflowCommand({ ...f, argv: [process.execPath, "-e", "process.stdout.write(Buffer.alloc(5 * 1024 * 1024, 65)); process.stderr.write('end'); process.exitCode = 17;"] });
    expect(result).toMatchObject({ status: "failed", exitCode: 17, log: { bytes: WORKFLOW_LIMITS.maxLogBytes, truncated: true } });
    expect(result.outputBytes).toBe(5 * 1024 * 1024 + 3);
    const path = join(f.logDirectory, result.log.id), bytes = await readFile(path), stat = await lstat(path);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(result.log.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(result.log.expiresAt).toBe(Math.ceil(stat.mtimeMs) + WORKFLOW_LIMITS.logRetentionMs);
  }, 10_000);

  commandTest("timeouts terminate a command that ignores TERM", async () => {
    const f = await fixture(), started = Date.now();
    const result = await runWorkflowCommand({ ...f, timeoutMs: 200, argv: [process.execPath, "-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 1000)"] });
    expect(result.status).toBe("timed_out");
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 8_000);

  commandTest("cleans up descendants that retain pipes after their parent exits", async () => {
    const f = await fixture(), pidFile = join(f.root, "descendant.pid");
    const descendant = "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 1000)";
    const source = `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'}); require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid)); c.unref(); process.exit(0);`;
    const result = await runWorkflowCommand({ ...f, argv: [process.execPath, "-e", source] });
    expect(result.status).toBe("passed");
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 8_000);

  commandTest("abort terminates the owned command", async () => {
    const f = await fixture(), controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 150);
    try {
      const result = await runWorkflowCommand({ ...f, signal: controller.signal, argv: [process.execPath, "-e", "setInterval(()=>{},1000)"] });
      expect(result.status).toBe("cancelled");
    } finally { clearTimeout(timer); }
  }, 8_000);

  test("unsupported platforms reject commands before execution or log creation", async () => {
    const f = await fixture(), marker = join(f.root, "command-ran");
    const argv = [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`];
    await expect(runWorkflowCommand({ ...f, platform: "win32", argv })).rejects.toMatchObject({ code: "unsupported_platform" });
    expect(await Bun.file(marker).exists()).toBe(false);
    await expect(lstat(f.logDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  commandTest("reserved logs are exclusive and symlinks are never followed", async () => {
    const f = await fixture(), id = `${"b".repeat(32)}.log`;
    await mkdir(f.logDirectory); await writeFile(join(f.root, "keep"), "keep"); await symlink(join(f.root, "keep"), join(f.logDirectory, id));
    await expect(runWorkflowCommand({ ...f, logId: id, argv: [process.execPath, "-e", "0"] })).rejects.toMatchObject({ code: "unsafe_log" });
    expect(await readFile(join(f.root, "keep"), "utf8")).toBe("keep");
  });

  test("cleanup removes only expired regular logs and preserves unrelated files", async () => {
    const f = await fixture(); await mkdir(f.logDirectory);
    const expired = join(f.logDirectory, `${"a".repeat(32)}.log`), link = join(f.logDirectory, `${"b".repeat(32)}.log`), other = join(f.logDirectory, "notes.txt");
    await writeFile(expired, "expired"); await writeFile(other, "keep"); await symlink(other, link);
    const old = new Date(Date.now() - WORKFLOW_LIMITS.logRetentionMs - 5_000); await utimes(expired, old, old);
    await expireLogs(f.logDirectory);
    expect(await Bun.file(expired).exists()).toBe(false); expect((await lstat(link)).isSymbolicLink()).toBe(true); expect(await readFile(other, "utf8")).toBe("keep");
  });
});
