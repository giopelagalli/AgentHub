import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface RecordedAction {
  seq: number;
  at: number;
  op: string;
  args?: unknown;
  /** File name of the frame taken after the action, or null once the cap is reached. */
  frame: string | null;
}

/** A long session shouldn't be able to fill the disk; the timeline is a summary, not a video. */
export const MAX_FRAMES = 200;

/**
 * The screenshot timeline of one browsing session: `<root>/<leaseId>/<seq>.jpg` plus an
 * `actions.jsonl` line per action, so a project log can replay what an agent did and what the page
 * looked like after each step.
 */
export class Recorder {
  private readonly root: string;
  private readonly maxFrames: number;
  private seqs = new Map<string, number>();

  constructor(opts: { root: string; maxFrames?: number }) {
    this.root = opts.root;
    this.maxFrames = opts.maxFrames ?? MAX_FRAMES;
  }

  dir(leaseId: string): string {
    return join(this.root, leaseId);
  }

  async record(leaseId: string, entry: { op: string; args?: unknown; at: number; jpeg?: Buffer }): Promise<RecordedAction> {
    const seq = (this.seqs.get(leaseId) ?? 0) + 1;
    this.seqs.set(leaseId, seq);
    const dir = this.dir(leaseId);
    await mkdir(dir, { recursive: true });
    let frame: string | null = null;
    if (entry.jpeg && seq <= this.maxFrames) {
      frame = `${seq}.jpg`;
      await writeFile(join(dir, frame), entry.jpeg);
    }
    const action: RecordedAction = {
      seq, at: entry.at, op: entry.op,
      ...(entry.args === undefined ? {} : { args: entry.args }),
      frame,
    };
    await appendFile(join(dir, 'actions.jsonl'), `${JSON.stringify(action)}\n`);
    return action;
  }

  /** The timeline for a lease; empty for one that never acted (or was never recorded). */
  async list(leaseId: string): Promise<RecordedAction[]> {
    let text: string;
    try {
      text = await readFile(join(this.dir(leaseId), 'actions.jsonl'), 'utf8');
    } catch {
      return [];
    }
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as RecordedAction);
  }
}
