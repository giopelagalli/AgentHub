const DEFAULT_TTL_MS = 30 * 60_000;

export interface PendingAction {
  id: string;
  description: string;
  run(): Promise<string>;
  createdAt: number;
}

/**
 * Holds outward-facing actions (anything that leaves the owner's own machines) until the owner
 * confirms them. Tools flagged `outward` never act themselves: they propose here and hand the model
 * back a pending id, so the only path to execution is an explicit confirm from the owner.
 *
 * `now` is injected so tests can age actions past the expiry without sleeping.
 */
export class ConfirmationGate {
  private actions = new Map<string, PendingAction>();
  private seq = 0;
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(opts: { now?: () => number; ttlMs?: number } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  }

  propose(description: string, run: () => Promise<string>): PendingAction {
    this.sweep();
    const action: PendingAction = { id: `act_${++this.seq}`, description, run, createdAt: this.now() };
    this.actions.set(action.id, action);
    return action;
  }

  pending(): PendingAction[] {
    this.sweep();
    return [...this.actions.values()];
  }

  async confirm(id: string): Promise<string> {
    this.sweep();
    const action = this.actions.get(id);
    if (!action) throw new Error(`no pending action ${id}`);
    // Dropped before it runs, not after: one confirmation must not be able to fire a slow action twice.
    this.actions.delete(id);
    return action.run();
  }

  cancel(id: string): boolean {
    this.sweep();
    return this.actions.delete(id);
  }

  private sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, action] of this.actions) if (action.createdAt <= cutoff) this.actions.delete(id);
  }
}
