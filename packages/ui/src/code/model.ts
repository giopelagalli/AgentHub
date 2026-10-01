/**
 * What the Code screen is made of, and the pure part of its file tree.
 *
 * The hub sends the workspace as one flat, sorted list; everything the tree does on screen —
 * which rows are visible, where the arrow keys land, what has to be expanded to reveal a file the
 * code map linked to — is a function of that list and the set of open folders. Keeping it pure
 * keeps the view a renderer.
 */

/** One entry of the workspace, as `GET /api/projects/:slug/code/tree` sends it. */
export interface CodeEntry {
  /** Workspace-relative, '/'-separated, no leading slash. */
  path: string;
  dir: boolean;
  size: number;
  /** False for a directory, a binary file, or one the viewer refuses by size. */
  openable: boolean;
}

export interface CodeTreeDoc {
  entries: CodeEntry[];
  /** The walk hit the hub's cap: what is on screen is not the whole workspace. */
  truncated: boolean;
}

/** One file, as `GET …/code/file?path=` sends it. */
export interface CodeFileDoc {
  path: string;
  text: string;
  lines: number;
}

/** What the big button reads, from `GET …/code`. */
export interface CodeSummaryDoc {
  files: number;
  truncated: boolean;
  map: { updatedAt: number } | null;
}

/** One row of the tree as it is drawn. */
export interface TreeRow {
  entry: CodeEntry;
  /** How deep the row is indented: 0 at the workspace root. */
  depth: number;
  /** The last segment of the path — what the row is labelled with. */
  name: string;
}

/** The folder a path sits in, and its folders, outermost first. `src/a/b.ts` → `src`, `src/a`. */
export function ancestors(path: string): string[] {
  const parts = path.split('/').slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

/**
 * The rows on screen: every entry all of whose ancestor folders are expanded, in the order the hub
 * sent them (alphabetical within each directory).
 */
export function visibleRows(entries: CodeEntry[], expanded: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const entry of entries) {
    const parents = ancestors(entry.path);
    if (!parents.every((dir) => expanded.has(dir))) continue;
    rows.push({ entry, depth: parents.length, name: entry.path.slice(entry.path.lastIndexOf('/') + 1) });
  }
  return rows;
}

/**
 * Where an arrow key lands: the row `delta` away from `selected`, stopping at either end rather
 * than wrapping. With nothing selected, it starts at the first row.
 */
export function step(rows: TreeRow[], selected: string | null, delta: 1 | -1): string | null {
  if (!rows.length) return null;
  const at = rows.findIndex((row) => row.entry.path === selected);
  if (at < 0) return rows[0].entry.path;
  const next = Math.min(rows.length - 1, Math.max(0, at + delta));
  return rows[next].entry.path;
}

/** `240 B`, `12.4 KB`, `2.1 MB`: a file's size on its tree row. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
