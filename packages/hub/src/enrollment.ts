import { createHash, randomBytes } from 'node:crypto';
import type { Db } from './db.js';

/**
 * Who owns what, until accounts land (PRD FR-D5 / D2). Every node and every enrollment token is
 * stamped with the acting user; there is exactly one of those today, and this is its name.
 */
export const ADMIN_USER = 'admin';

/**
 * A node name has to survive being a URL path segment (`/api/nodes/:name/heartbeat`) and a column in
 * the Cluster table. Enrollment is an open route, so the one name an unauthenticated caller gets to
 * choose is checked here rather than trusted. Hostnames, which is what the installer sends, pass.
 */
export const NODE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** How long a minted enrollment token stays usable (PRD FR-D1). */
export const ENROLLMENT_TTL_MS = 24 * 60 * 60 * 1000;
/** Bytes of entropy behind an enrollment token — 32 hex characters, short enough to read out loud. */
const ENROLLMENT_TOKEN_BYTES = 16;
/** Bytes behind a per-node bearer — 48 hex characters. It is never typed by a human. */
const NODE_TOKEN_BYTES = 24;

/** The one place a token becomes its stored form. Tokens are opaque hex, so no salt buys anything. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export const newEnrollmentToken = (): string => randomBytes(ENROLLMENT_TOKEN_BYTES).toString('hex');
export const newNodeToken = (): string => randomBytes(NODE_TOKEN_BYTES).toString('hex');

/** The plaintext token and when it stops working; the caller returns both and keeps neither. */
export interface MintedToken {
  token: string;
  expiresAt: number;
}

/**
 * The one-time tokens that turn a bare machine into an owned node. Plaintext is handed back exactly
 * once, at mint; from then on only the sha256 exists, so the table is worth nothing to a reader.
 */
export class EnrollmentTokens {
  constructor(private db: Db) {}

  /** Mints a token for `createdBy`, valid for 24h. `suggestedName` is what the owner typed, if anything. */
  mint(createdBy: string, suggestedName?: string, now = Date.now()): MintedToken {
    const token = newEnrollmentToken();
    const expiresAt = now + ENROLLMENT_TTL_MS;
    this.db.prepare(`
      INSERT INTO enrollment_tokens (token_hash, created_by, created_at, expires_at, suggested_name)
        VALUES (?,?,?,?,?)
    `).run(hashToken(token), createdBy, now, expiresAt, suggestedName ?? null);
    return { token, expiresAt };
  }

  /**
   * Spends `token`, returning who minted it. Null when it never existed, was already used, or has
   * expired — the three are one answer on purpose, so a caller cannot probe which tokens are real.
   * The update is the check: `used_at IS NULL` in the WHERE clause is what makes "single use" hold
   * even if two installers race the same token.
   */
  consume(token: string, now = Date.now()): { createdBy: string } | null {
    const hash = hashToken(token);
    const res = this.db.prepare(`
      UPDATE enrollment_tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at > ?
    `).run(now, hash, now);
    if (res.changes === 0) return null;
    const row = this.db.prepare(`SELECT created_by FROM enrollment_tokens WHERE token_hash=?`)
      .get(hash) as { created_by: string };
    return { createdBy: row.created_by };
  }

  /**
   * Whether `token` is real, unused and unexpired — without spending it. The source-tarball route
   * needs to check a token on every request rather than consume it on the first one (the installer
   * still has to trade it in at `/api/nodes/enroll` right after); `consume` remains the only place a
   * token is ever marked used.
   */
  isValid(token: string, now = Date.now()): boolean {
    const hash = hashToken(token);
    const row = this.db.prepare(`
      SELECT 1 FROM enrollment_tokens WHERE token_hash=? AND used_at IS NULL AND expires_at > ?
    `).get(hash, now);
    return row !== undefined;
  }
}

/**
 * The hub as the machine being enrolled will have to reach it — which is the URL the browser is
 * looking at, not anything the hub knows about itself. `Origin` is the client's own view and wins;
 * failing that, Fastify's `protocol`/`host`, which follow `X-Forwarded-Proto`/`X-Forwarded-Host`
 * when (and only when) the hub was started with `trustProxy`, and are the request's scheme and
 * `Host` header otherwise.
 */
export function hubUrlFrom(req: { headers: { origin?: string }; protocol: string; host: string }): string {
  const origin = req.headers.origin;
  // A sandboxed iframe sends `Origin: null`, and an opaque origin names no hub at all.
  if (origin && /^https?:\/\/[^/]+$/.test(origin)) return origin;
  return `${req.protocol}://${req.host}`;
}

/** The one line the owner copies onto the new machine. The installer is written against this shape. */
export function installCommand(hubUrl: string, token: string): string {
  return `curl -fsSL ${hubUrl}/install.sh | sh -s -- --hub ${hubUrl} --token ${token}`;
}
