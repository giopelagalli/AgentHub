import { open, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** Bounds on the digest: it orients a turn, it does not stand in for reading the workspace. */
export const DIGEST_MAX_ENTRIES = 150;
export const DIGEST_MAX_CHARS = 6000;
const HEAD_BYTES = 1024;
const HEAD_LINE_LIMIT = 80;
const DIGEST_TRUNCATED = '\n[digest truncated]';

/** Never descended into: dependency trees, build output and nested checkouts are not the project's own files. */
const SKIPPED_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', 'dist', 'build', 'target', '__pycache__', '.next', 'coverage']);
const SKIPPED_FILES = new Set(['.gitkeep']);

/** Files whose first line says something about them — a comment, a shebang, a heading. */
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.rb', '.java', '.kt', '.swift', '.c', '.h', '.cc', '.cpp',
  '.cs', '.sh', '.sql', '.css', '.scss', '.html', '.vue', '.svelte', '.md', '.yaml', '.yml', '.toml',
]);

function isSource(path: string): boolean {
  const dot = path.lastIndexOf('.');
  return dot >= 0 && SOURCE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

const formatSize = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

/** The first non-empty line of a file's head, or '' when it has none (or is not readable as text). */
async function headLine(path: string): Promise<string> {
  try {
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
      const line = buf.subarray(0, bytesRead).toString('utf8').split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
      return line.length > HEAD_LINE_LIMIT ? `${line.slice(0, HEAD_LINE_LIMIT - 1)}…` : line;
    } finally {
      await fh.close();
    }
  } catch {
    return '';
  }
}

/**
 * `acc` is capped at `limit + 1`: one more than the digest ever shows, just enough for
 * `workspaceDigest` to know there were more. A workspace with a huge, skip-listed-adjacent tree
 * (a stray `vendor/` full of thousands of files, say) would otherwise cost a full recursive
 * `readdir` walk for entries nothing ever renders.
 */
async function walk(root: string, dir: string, acc: { path: string; size: number }[], limit: number): Promise<void> {
  if (acc.length > limit) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (acc.length > limit) return;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIPPED_DIRS.has(e.name)) await walk(root, full, acc, limit);
    } else if (e.isFile() && !SKIPPED_FILES.has(e.name)) {
      const size = await stat(full).then((s) => s.size, () => 0);
      acc.push({ path: relative(root, full).split(sep).join('/'), size });
    }
  }
}

/**
 * What exists in `workspace/`, one line per file — path, size, and for source files the line the
 * file opens with — so a turn knows the shape of the project without listing and reading it. Capped
 * at `DIGEST_MAX_ENTRIES` files and `DIGEST_MAX_CHARS` characters.
 */
export async function workspaceDigest(workspace: string): Promise<string> {
  const files: { path: string; size: number }[] = [];
  await walk(workspace, workspace, files, DIGEST_MAX_ENTRIES);
  if (files.length === 0) return '(empty)';
  const shown = files.slice(0, DIGEST_MAX_ENTRIES);
  const lines = await Promise.all(shown.map(async (f) => {
    const head = isSource(f.path) ? await headLine(join(workspace, f.path)) : '';
    return `${f.path} (${formatSize(f.size)})${head ? ` — ${head}` : ''}`;
  }));
  if (files.length > shown.length) lines.push(`… and ${files.length - shown.length} more files`);
  const text = lines.join('\n');
  return text.length <= DIGEST_MAX_CHARS ? text : text.slice(0, DIGEST_MAX_CHARS - DIGEST_TRUNCATED.length) + DIGEST_TRUNCATED;
}
