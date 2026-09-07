import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Cookie the browser session lives in. */
export const SESSION_COOKIE = 'hub_session';

/** Session lifetime. The signed token carries its own expiry, so a forged cookie age proves nothing. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AuthOptions {
  /** The owner's password. Compared in constant time. */
  password: string;
  /** Shared secret daemons send as `Authorization: Bearer <token>`; without one no bearer is accepted. */
  daemonToken?: string;
  /** HMAC key for session tokens. Absent, a random one is generated — every restart logs the owner out. */
  sessionSecret?: string;
  /** Injected in tests so expiry can be driven without waiting on real time. */
  now?: () => number;
}

/**
 * How a route is guarded. `none` is unguarded (the static UI, which has to be reachable to render
 * the login box), `open` is a guarded prefix's explicit exception, `daemon` accepts the daemon
 * bearer *or* an owner session, and `owner` accepts the session cookie only.
 */
export type Access = 'none' | 'open' | 'daemon' | 'owner';

/**
 * The `<METHOD> <route>` pairs a daemon bearer may reach: `/api/jobs/claim` plus the per-job report
 * routes it calls while running one, and the two registration routes. Anything absent is the
 * owner's.
 */
const DAEMON_ROUTES = new Set([
  'POST /api/nodes/register',
  'POST /api/nodes/:name/heartbeat',
  'POST /api/jobs/claim',
  'POST /api/jobs/:id/log',
  'POST /api/jobs/:id/complete',
  'POST /api/jobs/:id/fail',
]);

/**
 * The policy, as a pure function of method and *matched route*: everything under `/api/` and the
 * `/ws` upgrade needs auth except the login route and the health probe. Daemon-facing routes take
 * the bearer token — and the owner cookie too, since the owner may drive the same routes from the
 * UI and a session is strictly the stronger credential. The browser relay is deliberately not one
 * of them: a leaked daemon token must not be able to drive the owner's browser.
 *
 * `route` is the pattern the router matched (`/api/jobs/:id/log`), never the request's raw path:
 * find-my-way percent-decodes before matching, so classifying the raw path let `/%61pi/state`
 * through unguarded. An unmatched request (`route` undefined) or a route this function does not
 * recognise is denied by default, so a new route is guarded until someone classifies it.
 */
export function routeAccess(method: string, route: string | undefined): Access {
  if (route === undefined) return 'owner';
  if (route === '/ws') return 'owner';
  if (route !== '/api' && !route.startsWith('/api/')) return 'none';
  if ((method === 'GET' || method === 'HEAD') && route === '/api/health') return 'open';
  if (method === 'POST' && route === '/api/login') return 'open';
  if (DAEMON_ROUTES.has(`${method} ${route}`)) return 'daemon';
  return 'owner';
}

/**
 * Splits a `Cookie` header into its pairs. Malformed pairs are skipped rather than thrown over —
 * including a value that is not valid percent-encoding (`hub_session=%`), which would otherwise
 * turn a hostile header into a 500.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    try {
      out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      continue;
    }
  }
  return out;
}

/** Failed logins allowed from one client before it is locked out. */
export const LOGIN_MAX_FAILURES = 5;
/** How long failures are remembered, and how long a lockout lasts after the last one. */
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
/** Above this many tracked clients, expired entries are swept so a spray cannot grow the map forever. */
const THROTTLE_SWEEP_AT = 1024;

/**
 * Per-client failed-login counter. In memory only: a restart forgets it, which is acceptable for a
 * single-owner hub and keeps the password out of a lockout table on disk.
 */
export class LoginThrottle {
  private readonly clients = new Map<string, { count: number; until: number }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** True while this client is locked out — checked before the password, so a correct one waits too. */
  blocked(client: string): boolean {
    const entry = this.clients.get(client);
    if (!entry) return false;
    if (entry.until <= this.now()) {
      this.clients.delete(client);
      return false;
    }
    return entry.count >= LOGIN_MAX_FAILURES;
  }

  /** Records a failure and returns the running count; the window restarts from this attempt. */
  fail(client: string): number {
    const now = this.now();
    if (this.clients.size >= THROTTLE_SWEEP_AT) {
      for (const [key, entry] of this.clients) if (entry.until <= now) this.clients.delete(key);
    }
    const entry = this.clients.get(client);
    const count = entry && entry.until > now ? entry.count + 1 : 1;
    this.clients.set(client, { count, until: now + LOGIN_WINDOW_MS });
    return count;
  }

  /** A successful login clears the client's history. */
  succeed(client: string): void {
    this.clients.delete(client);
  }
}

/**
 * Constant-time string comparison. Both sides are hashed first so the comparison never sees
 * different-length buffers (`timingSafeEqual` throws on those, and the throw itself would leak the
 * length of the secret).
 */
export function safeEqual(a: string, b: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(a), digest(b));
}

/** Password check, session issue/verify and the daemon bearer check — the whole credential surface. */
export class Auth {
  private readonly password: string;
  private readonly daemonToken: string | undefined;
  private readonly secret: string;
  private readonly now: () => number;

  constructor(opts: AuthOptions) {
    this.password = opts.password;
    this.daemonToken = opts.daemonToken;
    this.secret = opts.sessionSecret ?? randomBytes(32).toString('hex');
    this.now = opts.now ?? Date.now;
  }

  passwordOk(candidate: unknown): boolean {
    // A missing or non-string password still runs the comparison, so a malformed body is not a
    // faster "no" than a wrong password.
    return safeEqual(typeof candidate === 'string' ? candidate : '', this.password);
  }

  /** `<expiryMs>.<hmac>` — self-contained, so nothing about live sessions has to be stored. */
  issueSession(): string {
    const exp = String(this.now() + SESSION_TTL_MS);
    return `${exp}.${this.sign(exp)}`;
  }

  sessionOk(token: string | undefined): boolean {
    if (!token) return false;
    const dot = token.indexOf('.');
    if (dot <= 0) return false;
    const exp = token.slice(0, dot);
    if (!/^\d+$/.test(exp) || Number(exp) <= this.now()) return false;
    return safeEqual(token.slice(dot + 1), this.sign(exp));
  }

  /** True when the request carries a live owner session. */
  ownerOk(cookieHeader: string | undefined): boolean {
    return this.sessionOk(parseCookies(cookieHeader)[SESSION_COOKIE]);
  }

  bearerOk(authorization: string | undefined): boolean {
    if (!this.daemonToken || !authorization?.startsWith('Bearer ')) return false;
    return safeEqual(authorization.slice('Bearer '.length), this.daemonToken);
  }

  /**
   * A fresh session cookie. `Secure` is conditional because the hub is normally reached over plain
   * HTTP on the tailnet, where a Secure cookie would simply never be sent back.
   */
  sessionCookie(secure: boolean): string {
    return this.cookie(this.issueSession(), SESSION_TTL_MS / 1000, secure);
  }

  clearedCookie(secure: boolean): string {
    return this.cookie('', 0, secure);
  }

  private cookie(value: string, maxAgeSec: number, secure: boolean): string {
    return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('hex');
  }
}
