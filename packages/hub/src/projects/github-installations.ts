import type { Db } from '../db.js';

/**
 * Which GitHub App installations this hub knows about, and whose they are. One row per installation
 * the member completed from the Connect button: the id GitHub gave it, the account it sits on, and
 * when it was last seen.
 *
 * No token is stored. An installation id is not a credential — it names a grant the member made on
 * GitHub and can revoke there — so the table is worth nothing to a reader of the database, and
 * every actual token is minted per repository and thrown away (`AppCredentials`).
 */

export interface InstallationRow {
  installationId: number;
  user: string;
  accountLogin: string;
  accountType: string;
  createdAt: number;
  updatedAt: number;
}

interface Raw {
  installation_id: number;
  user: string;
  account_login: string;
  account_type: string;
  created_at: number;
  updated_at: number;
}

const toRow = (raw: Raw): InstallationRow => ({
  installationId: raw.installation_id,
  user: raw.user,
  accountLogin: raw.account_login,
  accountType: raw.account_type,
  createdAt: raw.created_at,
  updatedAt: raw.updated_at,
});

export class GithubInstallations {
  constructor(private readonly db: Db) {}

  /** The member's installations, oldest first. */
  list(user: string): InstallationRow[] {
    return (this.db
      .prepare(`SELECT * FROM github_installations WHERE user=? ORDER BY created_at`)
      .all(user) as Raw[]).map(toRow);
  }

  /**
   * Records an installation, or refreshes one already here. An installation id is unique across
   * GitHub, so re-installing or changing the chosen repositories updates the same row rather than
   * making a second one — and a row that somehow belongs to another member is moved, because the
   * person who just proved they own it on GitHub is the one who owns it here.
   */
  upsert(
    row: Omit<InstallationRow, 'createdAt' | 'updatedAt'>, now = Date.now(),
  ): void {
    this.db.prepare(`
      INSERT INTO github_installations (installation_id, user, account_login, account_type, created_at, updated_at)
        VALUES (?,?,?,?,?,?)
      ON CONFLICT(installation_id) DO UPDATE SET
        user=excluded.user, account_login=excluded.account_login,
        account_type=excluded.account_type, updated_at=excluded.updated_at
    `).run(row.installationId, row.user, row.accountLogin, row.accountType, now, now);
  }

  /** Forgets one of the member's installations. False when it was not theirs (or not here). */
  remove(user: string, installationId: number): boolean {
    const res = this.db
      .prepare(`DELETE FROM github_installations WHERE user=? AND installation_id=?`)
      .run(user, installationId);
    return res.changes > 0;
  }
}
