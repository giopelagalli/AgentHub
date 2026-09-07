import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

// Lives in its own entry point (`@agenthub/shared/data-stamp`) rather than the package index: the
// index is bundled into the browser UI, which must not pull in node:fs.

/**
 * Files that cannot be part of a fingerprint two machines must agree on.
 *
 * SQLite's sidecars are rewritten under an open database (and the `-shm` only exists while one is
 * open at all). The live `hub.db` is the same problem one level up: the hub keeps writing to it for
 * the whole switch window, so the bytes on the target are a copy of a moving file. It is not the
 * database the target actually runs — `checkpoint.db`, the `VACUUM INTO` snapshot synced beside it,
 * is (see `HubProcess.adoptCheckpoint`) — so the live file is skipped and the snapshot is hashed.
 */
const SKIP = /^\/hub\.db$|-(wal|shm)$/;

/** Content-hashed rather than sized: the database is the state, and a torn copy has the right size. */
const HASH_CONTENT = /\.db$/;

const CHUNK_HASH = async (path: string): Promise<string> => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
};

/**
 * A fingerprint of a data root: every regular file's path plus, for a database, a sha256 of its
 * contents and for everything else its size. Both control nodes compute it the same way, so the hub
 * can prove the copy it just pushed matches what it sent before it hands the hub over (PRD §4.2:
 * refuse to start on a stale sync).
 *
 * Sizes and not mtimes for the bulk: `rsync -a` preserves timestamps but a plain `cp -r` does not,
 * and the stamp has to mean the same thing whichever copy mechanism the deployment uses. The
 * database gets the stronger check because it is the only file whose content silently decides
 * whether the hub comes back up with the owner's state or with a corrupt page. A missing root
 * stamps as empty rather than throwing — the target's data root does not exist before its first sync.
 */
export async function dataStamp(root: string): Promise<string> {
  const entries: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    const items = await readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const abs = join(dir, item.name);
      if (item.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!item.isFile()) continue;
      const rel = relative(root, abs).split(sep).join('/');
      if (SKIP.test(`/${rel}`)) continue;
      entries.push(`${rel}\0${HASH_CONTENT.test(item.name) ? await CHUNK_HASH(abs) : (await stat(abs)).size}`);
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
