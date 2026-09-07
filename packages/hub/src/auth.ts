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

/** `/api/jobs/claim` plus the per-job report routes a daemon calls while running one. */
const DAEMON_JOB_ROUTE = /^\/api\/jobs\/(?:claim|\d+\/(?:log|complete|fail))$/;

/**
 * The policy, as a pure function of method and path: everything under `/api/` and the `/ws` upgrade
 * needs auth except the login route and the health probe. Daemon-facing routes take the bearer token
 * — and the owner cookie too, since the owner may drive the same routes from the UI (the browser
 * relay is one of them) and a session is strictly the stronger credential.
 */
export function routeAccess(method: string, pathname: string): Access {
  if (pathname === '/ws') return 'owner';
  if (pathname !== '/api' && !pathname.startsWith('/api/')) return 'none';
  if (method === 'GET' && pathname === '/api/health') return 'open';
  if (method === 'POST' && pathname === '/api/login') return 'open';
  if (pathname === '/api/nodes' || pathname.startsWith('/api/nodes/')) return 'daemon';
  if (DAEMON_JOB_ROUTE.test(pathname)) return 'daemon';
  if (pathname === '/api/browser/act') return 'daemon';
  return 'owner';
}

/** Splits a `Cookie` header into its pairs. Malformed pairs are skipped rather than thrown over. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
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
