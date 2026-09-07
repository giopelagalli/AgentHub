import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

// Lives in its own entry point (`@agenthub/shared/data-stamp`) rather than the package index: the
// index is bundled into the browser UI, which must not pull in node:fs.

/**
 * SQLite's sidecar files. They are rewritten under an open database (and the `-shm` only exists
 * while one is open at all), so they would make the stamp differ between a live hub and the copy
 * that just landed on the target even when every byte that matters is identical.
 */
const SKIP = /-(wal|shm)$/;

/**
 * A content-independent fingerprint of a data root: every regular file's path and size, hashed.
 * Both control nodes compute it the same way, so the hub can prove the copy it just pushed matches
 * what it sent before it hands the hub over (PRD §4.2: refuse to start on a stale sync).
 *
 * Sizes and not mtimes: `rsync -a` preserves timestamps but a plain `cp -r` does not, and the stamp
 * has to mean the same thing whichever copy mechanism the deployment uses. A missing root stamps as
 * empty rather than throwing — the target's data root does not exist before its first sync.
 */
export async function dataStamp(root: string): Promise<string> {
  const entries: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    const items = await readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const abs = join(dir, item.name);
      if (item.isDirectory()) {
        await walk(abs);
      } else if (item.isFile() && !SKIP.test(item.name)) {
        entries.push(`${relative(root, abs).split(sep).join('/')}\0${(await stat(abs)).size}`);
      }
    }
  };

  try {
    await walk(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  entries.sort();
  return createHash('sha256').update(entries.join('\n')).digest('hex');
}
