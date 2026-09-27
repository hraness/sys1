import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export class ProjectFileError extends Error {
  readonly exitCode = 2;
}

/** Create a small project-owned file exclusively; edited files and links are
 * never replaced. The caller supplies a canonical repository root from
 * node:fs/promises.realpath, as resolveReviewRoot does. */
export async function writeProjectFile(root: string, path: string, text: string, dryRun: boolean): Promise<"created" | "unchanged" | "planned"> {
  if (path.includes("\0") || isAbsolute(path) || path.split(/[\\/]/).some((part) => part === ".." || part === "." || part === "")) {
    throw new ProjectFileError("Invalid project destination");
  }
  const intended = Buffer.from(text, "utf8");
  if (intended.length > 65_536) throw new ProjectFileError("Project file exceeds its size limit");
  const destination = resolve(root, path);
  const rel = relative(root, destination);
  if (rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new ProjectFileError("Destination is outside the repository");
  const parents = relative(root, dirname(destination)).split(sep).filter(Boolean);
  let parent = root;
  for (const part of parents) {
    parent = join(parent, part);
    let stat;
    try { stat = await lstat(parent); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      if (dryRun) continue;
      try { await mkdir(parent, { mode: 0o755 }); }
      catch (created) { if (!(created instanceof Error) || !("code" in created) || created.code !== "EEXIST") throw created; }
      stat = await lstat(parent);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ProjectFileError("Project destination contains a link or non-directory");
  }
  // Recheck each existing ancestor after creation, including canonical root.
  if (await realpath(root) !== root) throw new ProjectFileError("Repository location changed during setup");
  parent = root;
  for (const part of parents) {
    parent = join(parent, part);
    let stat;
    try { stat = await lstat(parent); }
    catch (error) {
      if (dryRun && (error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(parent) !== parent) {
      throw new ProjectFileError("Project destination changed during setup");
    }
  }
  let existing;
  try { existing = await lstat(destination); }
  catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error; }
  if (existing !== undefined) {
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 || existing.size > 65_536) {
      throw new ProjectFileError("Project destination is not a small regular file");
    }
    const file = await open(destination, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const actual = await file.stat();
      if (!actual.isFile() || actual.nlink !== 1 || actual.ino !== existing.ino || actual.dev !== existing.dev || actual.size > 65_536) throw new ProjectFileError("Project destination changed during setup");
      const bytes = Buffer.alloc(65_537);
      let used = 0;
      while (used < bytes.length) {
        const { bytesRead } = await file.read(bytes, used, bytes.length - used, used);
        if (bytesRead === 0) break;
        used += bytesRead;
      }
      const after = await file.stat();
      if (used > 65_536 || after.size !== actual.size || after.mtimeMs !== actual.mtimeMs || after.nlink !== 1) {
        throw new ProjectFileError("Project destination changed during setup");
      }
      if (bytes.subarray(0, used).equals(intended)) return "unchanged";
    } finally { await file.close(); }
    throw new ProjectFileError("Project file already exists with different content; review it manually");
  }
  if (dryRun) return "planned";
  // Exclusive open avoids replacing a concurrent creator or following a final link.
  const file = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o644);
  try { await file.writeFile(intended); await file.sync(); }
  finally { await file.close(); }
  return "created";
}
