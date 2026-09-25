import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { simpleGit, type SimpleGit } from 'simple-git';
import { CODE_MAP_TOOL_CALLS } from '../agents/budgets.js';
import type { AgentLoop } from '../agents/loop.js';
import { bundleTools, docTools, realWorkspacePath, workspaceTools, type Tool } from '../agents/tools.js';
import { routeFor } from '../gateway.js';
import type { ProjectBundle } from './bundle.js';
import { SKIPPED_DIRS, SKIPPED_FILES } from './digest.js';
import { COMMITTER_ENV, isCommitExcluded } from './github.js';
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
  const full = await realWorkspacePath(workspace, path);
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
  // Neither `/etc/gitconfig` nor `~/.gitconfig` configures a commit the hub makes: an `insteadOf`
  // rewrite, a credential helper or a hook template there belongs to whoever runs this machine,
  // not to this commit. Same reasoning as `Github.gitEnv` (0028).
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  ...COMMITTER_ENV,
});

/** A path the owner's editor may not read or write, whatever the containment check says about it. */
const isProtectedPath = (path: string): boolean =>
  path.split('/').some((segment) => SKIPPED_DIRS.has(segment));

const NOT_OWN_CODE = "path is not the project's own code";

/** Where a saved file's commit went, and `'none'` when there was deliberately no commit. */
export type CommitTarget = 'workspace' | 'bundle' | 'none';

/**
 * True when this checkout's ignore rules already say the file is not versioned.
 *
 * Read off the *output*, not the exit code: `check-ignore` exits 1 for "not ignored", and
 * simple-git reports that as success with an empty string rather than as a failure. It prints the
 * path when a rule matches and nothing when none does, which is unambiguous either way. A file
 * that is already tracked is never reported, which is what we want — it is committed as usual.
 */
async function isIgnored(git: SimpleGit, path: string): Promise<boolean> {
  return git.raw(['check-ignore', '--', path]).then((out) => out.trim().length > 0, () => false);
}

/**
 * Writes one file and records it as the owner's own commit.
 *
 * Where the commit lands is decided by what the workspace *is*. An imported project's workspace is
 * its own checkout — the bundle's index excludes it (see `ProjectBundle.excludeNestedRepos`), so a
 * bundle commit would record nothing — and that checkout is what the next milestone pushes to the
 * owner's repository. A scaffolded workspace has no repository of its own and is versioned by the
 * bundle. Either way the edit is a commit before the next turn reads the file, which is the point:
 * an owner edit the agents can't see is an owner edit that gets overwritten.
 *
 * Two kinds of file are written and *not* committed, reported as `'none'` rather than as a failure:
 * one that matches the credential convention `Github` holds out of a milestone push
 * (`isCommitExcluded` — committing a `.env.production` here would put it in the history the next
 * push sends to the owner's repository), and one the repository's own ignore rules already exclude.
 * Both are ordinary things for the owner to edit; neither belongs in a commit.
 */
export async function writeCodeFile(bundle: ProjectBundle, path: string, text: string): Promise<CommitTarget> {
  const full = await realWorkspacePath(bundle.workspace, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, text, 'utf8');
  const message = `Owner edit: ${path}`;
  if (isCommitExcluded(path)) return 'none';

  if (!existsSync(join(bundle.workspace, '.git'))) {
    // The bundle stages the whole tree, so an ignored file simply never reaches the index and the
    // commit is a no-op. Compare the head to say which of the two happened.
    const before = await bundle.head();
    await bundle.commit(message);
    return (await bundle.head()) === before ? 'none' : 'bundle';
  }
  // The clone is the owner's repository: no identity is written into its config (0028), and its
  // hooks — which agents can write — stay out of a commit the hub makes. `allowUnsafeHooksPath` and
  // `allowUnsafeConfigPaths` are what let `core.hooksPath` and `GIT_CONFIG_GLOBAL` be set at all,
  // and both are used here to take configuration away rather than to add it.
  const git = simpleGit(bundle.workspace, {
    unsafe: { allowUnsafeHooksPath: true, allowUnsafeConfigPaths: true },
  }).env(commitEnv());
  // `:(literal)` so a path containing `*`, `[` or a leading `:` is a filename and not a pathspec.
  const pathspec = `:(literal)${path}`;
  if (await isIgnored(git, path)) return 'none';
  await git.raw(['-c', 'core.hooksPath=/dev/null', 'add', '--', pathspec]);
  const staged = (await git.raw(['diff', '--cached', '--name-only', '--', pathspec])).trim();
  if (!staged) return 'none';
  await git.raw(['-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '-m', message]);
  return 'workspace';
}

/**
 * The read tools the map task gets: the same ones the guide has, and `write_code_map` to finish
 * with — wrapped so the route can say whether the page was actually rewritten. A run that spends
 * its budget reading and never writes is a run that changed nothing, and the owner is told that
 * rather than "refreshed".
 */
function codeMapTools(onWrite: () => void): Tool[] {
  const reads = workspaceTools().filter((t) => ['read_file', 'list_dir'].includes(t.def.name));
  const bundleReads = bundleTools().filter((t) => t.def.name === 'read_bundle');
  const write = docTools('owner')
    .filter((t) => t.def.name === 'write_code_map')
    .map((tool): Tool => ({
      ...tool,
      run: async (args, ctx) => {
        const result = await tool.run(args, ctx);
        onWrite();
        return result;
      },
    }));
  return [...reads, ...bundleReads, ...write];
}

/** What *Refresh map* comes back with: the page as it now stands, and whether this run wrote it. */
export interface CodeMapResult {
  markdown: string;
  written: boolean;
}

/**
 * The *Refresh map* button: one manager-shaped task whose whole job is to call `write_code_map`.
 *
 * It is the same page the manager refreshes after a milestone (FR-B5) — the button exists because
 * the owner shouldn't have to run a turn to get an up-to-date way into the code. Returns the page
 * as it stands afterwards, which is the old one when the model declined to write a new one.
 */
export async function refreshCodeMap(
  loop: AgentLoop, bundle: ProjectBundle, slug: string, signal?: AbortSignal,
): Promise<CodeMapResult> {
  const route = routeFor((await bundle.manifest()).modelPolicy, 'orchestrator');
  let written = false;
  await loop.run({
    kind: 'chat', subject: `${slug}:${CODE_MAP_PAGE}`, tier: 'orchestrator',
    system: codeMapPrompt(await guideContext(bundle)),
    user: CODE_MAP_INSTRUCTION,
    tools: codeMapTools(() => { written = true; }),
    ctx: { bundle },
    maxToolCalls: CODE_MAP_TOOL_CALLS,
    ...(route ? { route } : {}),
    ...(signal ? { signal } : {}),
  });
  return { markdown: (await bundle.doc(CODE_MAP_PAGE)) ?? '', written };
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
    // The tree never lists these, so a request naming one did not come from the screen.
    if (isProtectedPath(path)) return reply.code(400).send({ error: NOT_OWN_CODE });
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

  // Fastify's 1 MB default body limit sits below the 2 MB file the viewer will happily open, so a
  // large file would open, edit and then fail to save. The slack covers the JSON escaping of it.
  app.put('/api/projects/:slug/code/file', { bodyLimit: FILE_MAX_BYTES + 64 * 1024 }, async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const body = (req.body ?? {}) as Partial<{ path: string; text: string }>;
    if (typeof body.path !== 'string' || !body.path || typeof body.text !== 'string') {
      return reply.code(400).send({ error: 'invalid file' });
    }
    if (isProtectedPath(body.path)) return reply.code(400).send({ error: NOT_OWN_CODE });
    const bundle = await deps.resolveProject(slug, reply);
    if (!bundle) return reply;
    try {
      const committed = await writeCodeFile(bundle, body.path, body.text);
      return { path: body.path, committed };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /**
   * One map refresh per project at a time. Two presses of *Refresh map* would otherwise be two
   * model runs writing the same page, and the second one's commit would land on top of a page the
   * first was still deciding about.
   */
  const refreshing = new Map<string, Promise<CodeMapResult>>();

  app.post('/api/projects/:slug/code/map', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const bundle = await deps.resolveProject(slug, reply);
    if (!bundle) return reply;
    const running = refreshing.get(slug);
    if (running) return reply.code(409).send({ error: 'a map refresh is already running for this project' });
    // A client that navigates away or closes the sheet should not leave a model run finishing for
    // nobody — the same wiring the chat and plan routes use.
    const ac = new AbortController();
    req.raw.on('close', () => ac.abort());
    const run = refreshCodeMap(deps.loop, bundle, slug, ac.signal);
    refreshing.set(slug, run);
    try {
      return await run;
    } finally {
      refreshing.delete(slug);
    }
  });
}
