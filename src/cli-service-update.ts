import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Old daemons have no updater lease. Unknown ownership must keep their code in place. */
export function daemonPreventsUpdate(
  env: NodeJS.ProcessEnv = process.env,
  alive: (pid: number) => boolean = pid => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  },
): boolean {
  const home = env.SYS1_HOME || join(homedir(), ".sys1");
  let fd: number | undefined;
  try {
    fd = openSync(join(home, "daemon.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = fstatSync(fd);
    if (!metadata.isFile() || metadata.size > 4096) return true;
    const buffer = Buffer.alloc(4097);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes > 4096) return true;
    const value: unknown = JSON.parse(buffer.subarray(0, bytes).toString("utf8"));
    if (typeof value !== "object" || value === null || !("pid" in value)
      || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid)
      || value.pid < 2 || value.pid > 2147483647) return true;
    return alive(value.pid);
  } catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
  finally { if (fd !== undefined) closeSync(fd); }
}
