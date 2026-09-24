import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { simpleGit } from 'simple-git';
import { CHAT_TOOL_CALLS } from '../agents/budgets.js';
import type { AgentLoop } from '../agents/loop.js';
import { bundleTools, docTools, workspacePath, workspaceTools, type Tool } from '../agents/tools.js';
import { routeFor } from '../gateway.js';
import type { ProjectBundle } from './bundle.js';
import { SKIPPED_DIRS, SKIPPED_FILES } from './digest.js';
import { COMMITTER_ENV } from './github.js';
import { CODE_MAP_INSTRUCTION, CODE_MAP_PAGE, codeMapPrompt } from './prompts.js';
import { guideContext } from './chat.js';

/**
 * The Code screen's hub half (FR-B3, FR-B5): the workspace as a tree, one file read or written, and
 * the one-off task that refreshes the code map.
 *
 * Everything here is the *owner's* view of the workspace, not an agent's. It shares the agents'
 * containment check (`workspacePath`) and their ignore list (`SKIPPED_DIRS`) deliberately: a file
 * the digest hides from a turn is a file the tree hides from the owner, and a path an agent may not
 * reach is a path the owner's editor may not write either.
 */

/** Entries the tree will return before it gives up and says so. */
export const TREE_MAX_ENTRIES = 5000;

/** The largest file the viewer opens. Bigger ones are listed, and read as a 415. */
export const FILE_MAX_BYTES = 2 * 1024 * 1024;

/** How much of a file is sniffed for the NUL byte that says "this is not text". */
const SNIFF_BYTES = 8192;

/**
 * Extensions the tree marks unopenable without reading anything. It is a hint, not the check: the
 * file route decodes the bytes and refuses whatever is not valid UTF-8, whatever its name.
 */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp', '.tif', '.tiff', '.heic', '.psd',
  '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.jar', '.class', '.wasm', '.node',
  '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.wav', '.ogg', '.webm', '.flac',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.so', '.dylib', '.dll', '.exe', '.bin', '.pyc', '.db', '.sqlite', '.sqlite3',
]);

/** One row of the tree: a directory, or a file with its size and whether the viewer will open it. */
export interface CodeEntry {
  /** Workspace-relative, always '/'-separated, no leading slash. */
  path: string;
  dir: boolean;
  /** Bytes; 0 for a directory. */
  size: number;
  /** False for a directory, a binary file, or one over `FILE_MAX_BYTES`. */
  openable: boolean;
}

export interface CodeTree {
  entries: CodeEntry[];
  /** True when the walk hit `TREE_MAX_ENTRIES` and stopped: the tree on screen is not the whole one. */
  truncated: boolean;
}

const extensionOf = (path: string): string => {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  return dot > slash ? path.slice(dot).toLowerCase() : '';
};

/**
 * The workspace as a flat, sorted list of directories and files — the UI builds the tree from it,
 * so one fetch is the whole picture and expanding a folder costs nothing.
 *
 * `SKIPPED_DIRS` (node_modules, .git, dist, …) is never descended into, for the same reason the
 * digest doesn't: it is not the project's own code, and it is where the entry cap would go.
 */
export async function workspaceTree(workspace: string, limit = TREE_MAX_ENTRIES): Promise<CodeTree> {
  const entries: CodeEntry[] = [];
  let truncated = false;

  const walk = async (dir: string): Promise<void> => {
    if (truncated) return;
    let listing;
    try {
      listing = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of listing.sort((a, b) => a.name.localeCompare(b.name))) {
      if (truncated) return;
      if (SKIPPED_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      const path = relative(workspace, full).split(sep).join('/');
      if (entries.length >= limit) { truncated = true; return; }
      if (e.isDirectory()) {
        entries.push({ path, dir: true, size: 0, openable: false });
        await walk(full);
      } else if (e.isFile() && !SKIPPED_FILES.has(e.name)) {
        const size = await stat(full).then((s) => s.size, () => 0);
        entries.push({
          path, dir: false, size,
          openable: size <= FILE_MAX_BYTES && !BINARY_EXTENSIONS.has(extensionOf(path)),
        });
      }
    }
  };

  await walk(workspace);
  return { entries, truncated };
}

export interface CodeFile {
  path: string;
  text: string;
  lines: number;
}

/** Why a file could not be opened, in the shape the route turns into a status code. */
export type CodeFileError = { status: 404 | 415; error: string };

/**
 * One file's text, or the reason there isn't any. UTF-8 only and `FILE_MAX_BYTES` at most: an
 * editor that opened a 30 MB binary would hang the tab, and one that opened a lossy decode of it
 * would save the losses back over the original.
 */
export async function readCodeFile(workspace: string, path: string): Promise<CodeFile | CodeFileError> {
  const full = workspacePath(workspace, path);
  const info = await stat(full).catch(() => null);
  if (!info) return { status: 404, error: 'no such file' };
  if (!info.isFile()) return { status: 415, error: 'not a file' };
  if (info.size > FILE_MAX_BYTES) return { status: 415, error: `file is larger than ${FILE_MAX_BYTES} bytes` };
  const buffer = await readFile(full);
  if (buffer.subarray(0, SNIFF_BYTES).includes(0)) return { status: 415, error: 'binary file' };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return { status: 415, error: 'not UTF-8 text' };
  }
  return { path, text, lines: text.length ? text.split('\n').length : 0 };
}

/**
 * The environment one owner-edit commit runs in: enough for git to work, the committer identity,
 * and nothing the hub's own environment happens to be carrying. The inherited `GIT_*` variables are
 * left out for the same reason `Github` drops them — `GIT_EDITOR`, `GIT_DIR` or a credential helper
 * in this process's environment is somebody else's configuration, not this commit's.
 */
const commitEnv = (): Record<string, string> => ({
  PATH: process.env.PATH ?? '',
  ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
  GIT_TERMINAL_PROMPT: '0',
  ...COMMITTER_ENV,
});

/** A path the owner's editor may not write, whatever the containment check says about it. */
const isProtectedPath = (path: string): boolean =>
  path.split('/').some((segment) => SKIPPED_DIRS.has(segment));

/**
 * Writes one file and records it as the owner's own commit.
 *
 * Where the commit lands is decided by what the workspace *is*. An imported project's workspace is
 * its own checkout — the bundle's index excludes it (see `ProjectBundle.excludeNestedRepos`), so a
 * bundle commit would record nothing — and that checkout is what the next milestone pushes to the
 * owner's repository. A scaffolded workspace has no repository of its own and is versioned by the
 * bundle. Either way the edit is a commit before the next turn reads the file, which is the point:
 * an owner edit the agents can't see is an owner edit that gets overwritten.
 */
export async function writeCodeFile(bundle: ProjectBundle, path: string, text: string): Promise<'workspace' | 'bundle'> {
  const full = workspacePath(bundle.workspace, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, text, 'utf8');
  const message = `Owner edit: ${path}`;

  if (!existsSync(join(bundle.workspace, '.git'))) {
    await bundle.commit(message);
    return 'bundle';
  }
  // The clone is the owner's repository: no identity is written into its config (0028), and its
  // hooks — which agents can write — stay out of a commit the hub makes. `allowUnsafeHooksPath` is
  // what lets `core.hooksPath` be set at all, and it is used here to take hooks away, not add them.
  const git = simpleGit(bundle.workspace, { unsafe: { allowUnsafeHooksPath: true } }).env(commitEnv());
  await git.raw(['-c', 'core.hooksPath=/dev/null', 'add', '--', path]);
  const staged = (await git.raw(['diff', '--cached', '--name-only', '--', path])).trim();
  if (staged) await git.raw(['-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '-m', message]);
  return 'workspace';
}

/** The read tools the map task gets: the same ones the guide has, and `write_code_map` to finish with. */
function codeMapTools(): Tool[] {
  const reads = workspaceTools().filter((t) => ['read_file', 'list_dir'].includes(t.def.name));
  const bundleReads = bundleTools().filter((t) => t.def.name === 'read_bundle');
  const write = docTools('owner').filter((t) => t.def.name === 'write_code_map');
  return [...reads, ...bundleReads, ...write];
}

/**
 * The *Refresh map* button: one manager-shaped task whose whole job is to call `write_code_map`.
 *
 * It is the same page the manager refreshes after a milestone (FR-B5) — the button exists because
 * the owner shouldn't have to run a turn to get an up-to-date way into the code. Returns the page
 * as it stands afterwards, which is the old one when the model declined to write a new one.
 */
export async function refreshCodeMap(loop: AgentLoop, bundle: ProjectBundle, slug: string): Promise<string> {
  const route = routeFor((await bundle.manifest()).modelPolicy, 'orchestrator');
  await loop.run({
    kind: 'chat', subject: `${slug}:${CODE_MAP_PAGE}`, tier: 'orchestrator',
    system: codeMapPrompt(await guideContext(bundle)),
    user: CODE_MAP_INSTRUCTION,
    tools: codeMapTools(),
    ctx: { bundle },
    maxToolCalls: CHAT_TOOL_CALLS,
    ...(route ? { route } : {}),
  });
  return (await bundle.doc(CODE_MAP_PAGE)) ?? '';
}

export interface CodeRouteDeps {
  /** The server's own slug resolution: it has already sent the 400/404 when this returns null. */
  resolveProject(slug: string, reply: FastifyReply): Promise<ProjectBundle | null>;
  loop: AgentLoop;
}

/**
 * The Code screen's routes. Every one is owner-only, which it gets for free: `routeAccess` gives
 * everything under `/api/` to the session cookie unless it is named as a daemon route, and none of
 * these is.
 */
export function codeRoutes(app: FastifyInstance, deps: CodeRouteDeps): void {
  /** What the big button shows without loading the tree twice. */
  app.get('/api/projects/:slug/code', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const bundle = await deps.resolveProject(slug, reply);
    if (!bundle) return reply;
    const { entries, truncated } = await workspaceTree(bundle.workspace);
    const map = (await bundle.docs()).pages.find((p) => p.slug === CODE_MAP_PAGE) ?? null;
    return {
      files: entries.filter((e) => !e.dir).length,
      truncated,
      map: map ? { updatedAt: map.updatedAt } : null,
    };
  });

  app.get('/api/projects/:slug/code/tree', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const bundle = await deps.resolveProject(slug, reply);
    if (!bundle) return reply;
    return workspaceTree(bundle.workspace);
  });

  app.get('/api/projects/:slug/code/file', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const { path } = (req.query ?? {}) as Partial<{ path: string }>;
    if (typeof path !== 'string' || !path) return reply.code(400).send({ error: 'invalid path' });
    const bundle = await deps.resolveProject(slug, reply);
    if (!bundle) return reply;
    let result: CodeFile | CodeFileError;
    try {
      result = await readCodeFile(bundle.workspace, path);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    if ('status' in result) return reply.code(result.status).send({ error: result.error });
    return result;
  });

  app.put('/api/projects/:slug/code/file', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const body = (req.body ?? {}) as Partial<{ path: string; text: string }>;
    if (typeof body.path !== 'string' || !body.path || typeof body.text !== 'string') {
      return reply.code(400).send({ error: 'invalid file' });
    }
    if (isProtectedPath(body.path)) return reply.code(400).send({ error: 'path is not the project\'s own code' });
    const bundle = await deps.resolveProject(slug, reply);
    if (!bundle) return reply;
    try {
      const committed = await writeCodeFile(bundle, body.path, body.text);
      return { path: body.path, committed };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post('/api/projects/:slug/code/map', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const bundle = await deps.resolveProject(slug, reply);
    if (!bundle) return reply;
    const markdown = await refreshCodeMap(deps.loop, bundle, slug);
    return { markdown };
  });
}
