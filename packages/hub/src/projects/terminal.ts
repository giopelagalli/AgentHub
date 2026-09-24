import { mkdir } from 'node:fs/promises';
import type { FastifyPluginAsync } from 'fastify';
import type { WebSocket } from 'ws';
import { spawn as spawnPty, type IPty } from 'node-pty';
import { secretsStripped } from '@agenthub/shared/shell';

/**
 * FR-B2 — the Terminal: a real shell in a project's `workspace/` on the hub host, carried over a
 * WebSocket to xterm.js in the browser.
 *
 * Security. This is the owner's own shell on the machine the hub runs on. It is scoped to nothing
 * more than the OS user running the hub — the same reach the owner already has over SSH — and it is
 * deliberately not sandboxed: `cd /` works, and so does everything else that user can do. Two
 * consequences are wired in rather than assumed:
 *
 *  - The route is `owner` under `routeAccess` (every `/api/` route not in `DAEMON_ROUTES` is), so
 *    the shared daemon bearer and a per-node token are both a plain 401 here. A leaked node token
 *    must never become a shell on the control node.
 *  - The shell is handed `secretsStripped(process.env)`, the same environment every agent-run
 *    command gets, so a terminal is not a way to read the hub's model keys, session secret or
 *    GitHub token out of its own process.
 *
 * Phase F narrows this further: a member reaches a terminal only on a node they own, never on a
 * granted one (PRD Security). Until then, owner-only is the whole of the policy.
 */

/** The route pattern, exported so `server.ts` can name it where a refused upgrade is hung up on. */
export const TERMINAL_ROUTE = '/api/projects/:slug/terminal';

/** Concurrent terminals this hub will carry. A shell is cheap; four of them is already a crowd. */
export const MAX_TERMINALS = 4;

/** A session with no traffic either way for this long is closed. */
export const TERMINAL_IDLE_MS = 60 * 60 * 1000;

/** How often sessions are swept: for idleness, and for a peer that has stopped answering. */
const SWEEP_MS = 30 * 1000;

/**
 * How long between keepalive pings. A socket whose peer vanished without a FIN — a laptop lid, a
 * dropped tunnel — stays "open" here forever, and a half-open one would hold both a pty and one of
 * the four session slots. A ping that goes unanswered until the next sweep ends the session.
 */
const PING_MS = 30 * 1000;

/**
 * Output is paused when this much of it is waiting on a slow socket, and resumed once the backlog
 * has drained to a quarter of it. Without this a `cat` of something enormous is buffered in the
 * hub's memory as fast as the pty can produce it.
 */
const SEND_HIGH_WATER = 1024 * 1024;
const SEND_LOW_WATER = SEND_HIGH_WATER / 4;

/** How long a closing session's process group gets to die on a HUP before it is killed outright. */
const KILL_ESCALATION_MS = 5000;

export interface TerminalDeps {
  /** The project store: `get` is the single gate between a caller's slug and a directory on disk. */
  projects: { get(slug: string): Promise<{ workspace: string }> };
  /** Injected in tests so the idle timeout can be driven without waiting an hour. */
  now?: () => number;
  /** Injected in tests, with the sweep interval, for the same reason. */
  sweepMs?: number;
  /** Injected in tests so a session is a predictable `/bin/sh` rather than the owner's own shell. */
  shell?: string;
}

/** A control frame the client may send. Anything else is ignored rather than an error. */
export type TerminalControl = { type: 'resize'; cols: number; rows: number };

/**
 * Parses a text frame from the client. Pure, and deliberately strict about the numbers: `resize`
 * reaches `ioctl(TIOCSWINSZ)`, so a NaN or a negative from a hostile client stops here.
 */
export function parseControl(text: string): TerminalControl | null {
  let msg: { type?: unknown; cols?: unknown; rows?: unknown };
  try {
    msg = JSON.parse(text) as { type?: unknown; cols?: unknown; rows?: unknown };
  } catch {
    return null;
  }
  if (msg.type !== 'resize') return null;
  const size = (value: unknown): number | null =>
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 1000 ? value : null;
  const cols = size(msg.cols);
  const rows = size(msg.rows);
  return cols && rows ? { type: 'resize', cols, rows } : null;
}

/**
 * Whether an upgrade may proceed, given the request's `Origin` and `Host`. A WebSocket handshake is
 * not subject to the same-origin policy and carries cookies, so any page in the owner's browser
 * could otherwise open this socket and hold a shell. A non-browser client (curl, a test) sends no
 * Origin and is let through — the session cookie is still the credential. The comparison is on the
 * full host *including the port*: "same site" is port-blind, and the prize here is a shell.
 */
export function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Whether the process group `pid` leads still has members. */
function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; } catch { return false; }
}

/**
 * Kills the shell's whole process group, not just the shell: node-pty puts the child in its own
 * session, so its pid doubles as the group id and a negative signal reaches everything it started
 * (a backgrounded server, an npm script). SIGHUP first — a shell losing its terminal is exactly
 * what that means — then SIGKILL for anything that ignored it.
 */
function killGroup(pid: number, immediate = false): void {
  if (!groupAlive(pid)) return;
  try { process.kill(-pid, 'SIGHUP'); } catch { /* already gone */ }
  if (immediate) {
    // The hub is going down and will not be here to run the escalation timer: nothing may outlive
    // it, so the group is killed outright rather than asked twice.
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
    return;
  }
  const escalate = setTimeout(() => {
    if (groupAlive(pid)) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }, KILL_ESCALATION_MS);
  escalate.unref?.();
}

interface Session {
  slug: string;
  pty: IPty;
  socket: WebSocket;
  startedAt: number;
  lastActivity: number;
  /** When the last keepalive ping went out, and whether it is still unanswered. */
  lastPing: number;
  awaitingPong: boolean;
  /** True while the pty is paused because the socket has too much output still to write. */
  paused: boolean;
}

/** Closes the socket after telling the client why, in a text frame it can put in its banner. */
function refuse(socket: WebSocket, reason: string, code: number): void {
  // Resumed first: the handler paused the socket, and a paused one never reads the client's half
  // of the closing handshake, so the close would hang until ws's own timeout destroyed it.
  socket.resume();
  try {
    socket.send(JSON.stringify({ type: 'error', message: reason }));
  } catch { /* the socket went away first */ }
  socket.close(code, reason);
}

export const terminalRoutes: FastifyPluginAsync<TerminalDeps> = async (app, deps) => {
  const now = deps.now ?? Date.now;
  const sessions = new Set<Session>();

  const end = (session: Session, why: string, immediate = false): void => {
    if (!sessions.delete(session)) return;
    const seconds = Math.round((now() - session.startedAt) / 1000);
    // Transcript-free by design: what the owner typed and what the shell answered is never logged,
    // only that a session existed, for which project, and for how long.
    console.log(`[terminal] ${session.slug} session ended after ${seconds}s (${why})`);
    killGroup(session.pty.pid, immediate);
  };

  const sweep = setInterval(() => {
    for (const session of sessions) {
      if (now() - session.lastActivity >= TERMINAL_IDLE_MS) {
        try {
          session.socket.send(JSON.stringify({ type: 'closed', reason: 'idle' }));
        } catch { /* closing anyway */ }
        session.socket.close(1000, 'idle');
        end(session, 'idle');
        continue;
      }
      if (now() - session.lastPing < PING_MS) continue;
      if (session.awaitingPong) {
        // No pong since the last ping: the peer is gone without having said so. `terminate` rather
        // than `close`, because a closing handshake with nobody on the other end never finishes.
        session.socket.terminate();
        end(session, 'no pong');
        continue;
      }
      session.awaitingPong = true;
      session.lastPing = now();
      try { session.socket.ping(); } catch { /* closing anyway */ }
    }
  }, deps.sweepMs ?? SWEEP_MS);
  sweep.unref?.();

  app.addHook('onClose', async () => {
    clearInterval(sweep);
    for (const session of [...sessions]) {
      session.socket.terminate();
      end(session, 'hub closing', true);
    }
  });

  app.get(TERMINAL_ROUTE, {
    websocket: true,
    // Before the upgrade, not after: a cross-origin page must never get as far as holding a socket.
    // The refused request hangs up its own connection for the same reason the auth hook's 401 does.
    onRequest: async (req, reply) => {
      if (originAllowed(req.headers.origin, req.headers.host)) return;
      console.warn(`[terminal] refused an upgrade from origin ${req.headers.origin}`);
      reply.raw.on('finish', () => reply.raw.socket?.end());
      return reply.code(403).send({ error: 'cross-origin' });
    },
  }, async (socket: WebSocket, req) => {
    const { slug } = req.params as { slug: string };
    // The handshake completes before this handler runs, so the client may already be sending —
    // xterm's first frame is the resize it fits itself to. Paused until the pty and the listeners
    // are wired, or those frames would be emitted to nobody and silently lost.
    socket.pause();
    // `projects.get` validates the slug before it becomes a path; an unknown one never reaches a pty.
    let workspace: string;
    try {
      workspace = (await deps.projects.get(slug)).workspace;
      await mkdir(workspace, { recursive: true });
    } catch {
      return refuse(socket, 'unknown project', 1008);
    }
    if (sessions.size >= MAX_TERMINALS) {
      return refuse(socket, `this hub carries ${MAX_TERMINALS} terminals at a time`, 1013);
    }

    const shell = deps.shell ?? process.env.SHELL ?? '/bin/sh';
    let child: IPty;
    try {
      child = spawnPty(shell, [], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: workspace,
        // The shell inherits PATH, HOME and everything a build needs — and no credential the hub
        // holds. AGENTHUB_PROJECT is there so a prompt or a script can tell where it is.
        env: { ...secretsStripped(process.env), TERM: 'xterm-256color', AGENTHUB_PROJECT: slug } as Record<string, string>,
      });
    } catch (err) {
      return refuse(socket, `could not start ${shell}: ${(err as Error).message}`, 1011);
    }

    const session: Session = {
      slug, pty: child, socket, startedAt: now(), lastActivity: now(),
      lastPing: now(), awaitingPong: false, paused: false,
    };
    sessions.add(session);
    console.log(`[terminal] ${slug} session started (${sessions.size}/${MAX_TERMINALS})`);

    child.onData((data) => {
      session.lastActivity = now();
      // Binary both ways: the pty's bytes are a stream, not a string, and a UTF-8 sequence that
      // straddles two chunks must not be mangled by a text frame's own validation.
      try {
        socket.send(Buffer.from(data, 'utf8'), { binary: true }, () => {
          // Fires once this frame has been written. Nothing follows a paused pty, so this is the
          // callback that sees the backlog drain.
          if (session.paused && socket.bufferedAmount <= SEND_LOW_WATER) {
            session.paused = false;
            child.resume();
          }
        });
      } catch { /* socket closing */ }
      if (!session.paused && socket.bufferedAmount > SEND_HIGH_WATER) {
        session.paused = true;
        child.pause();
      }
    });
    // A pong is the peer answering a ping, not the owner doing anything: it clears the keepalive
    // but deliberately does not count as activity, or a forgotten tab would never idle out.
    socket.on('pong', () => { session.awaitingPong = false; });
    child.onExit(({ exitCode }) => {
      try {
        socket.send(JSON.stringify({ type: 'closed', reason: `shell exited (${exitCode})` }));
      } catch { /* socket closing */ }
      socket.close(1000, 'shell exited');
      end(session, 'shell exited');
    });

    socket.on('message', (data: Buffer, isBinary: boolean) => {
      session.lastActivity = now();
      if (isBinary) {
        child.write(data.toString('utf8'));
        return;
      }
      const control = parseControl(data.toString('utf8'));
      if (control) child.resize(control.cols, control.rows);
    });
    socket.on('close', () => { end(session, 'socket closed'); });
    socket.on('error', () => { end(session, 'socket error'); });
    socket.resume();
  });
};
