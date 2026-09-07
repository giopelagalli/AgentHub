import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type PlannerList = 'goals' | 'todo' | 'backlog';

const LISTS: PlannerList[] = ['goals', 'todo', 'backlog'];
const LIST_TITLES: Record<PlannerList, string> = { goals: 'Goals', todo: 'Todo', backlog: 'Backlog' };
const ITEM_RE = /^- \[( |x)\] (.*)$/;
const SNAPSHOT_LIMIT = 2000;
const SNAPSHOT_MARKER = '\n[truncated]';

export class Planner {
  constructor(private readonly root: string, private readonly commit: (msg: string) => Promise<void>) {}

  private filePath(which: PlannerList): string {
    return join(this.root, `${which}.md`);
  }

  private async readLines(which: PlannerList): Promise<string[]> {
    const raw = await readFile(this.filePath(which), 'utf8').catch(() => '');
    return raw.split('\n').filter((l) => l.trim().length > 0);
  }

  private async writeLines(which: PlannerList, lines: string[]): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await writeFile(this.filePath(which), lines.length ? lines.join('\n') + '\n' : '', 'utf8');
  }

  async list(which: PlannerList): Promise<{ n: number; text: string; done: boolean }[]> {
    const lines = await this.readLines(which);
    return lines.map((line, i) => {
      const m = line.match(ITEM_RE);
      return { n: i + 1, text: m ? m[2] : line, done: m ? m[1] === 'x' : false };
    });
  }

  async add(which: PlannerList, text: string): Promise<number> {
    const lines = await this.readLines(which);
    lines.push(`- [ ] ${text}`);
    await this.writeLines(which, lines);
    await this.commit(`assistant: planner add ${which}`);
    return lines.length;
  }

  async complete(which: PlannerList, n: number): Promise<boolean> {
    const lines = await this.readLines(which);
    if (n < 1 || n > lines.length) return false;
    const m = lines[n - 1].match(ITEM_RE);
    if (!m) return false;
    lines[n - 1] = `- [x] ${m[2]}`;
    await this.writeLines(which, lines);
    await this.commit(`assistant: planner complete ${which}`);
    return true;
  }

  async remove(which: PlannerList, n: number): Promise<boolean> {
    const lines = await this.readLines(which);
    if (n < 1 || n > lines.length) return false;
    lines.splice(n - 1, 1);
    await this.writeLines(which, lines);
    await this.commit(`assistant: planner remove ${which}`);
    return true;
  }

  async snapshot(): Promise<string> {
    const parts: string[] = [];
    for (const which of LISTS) {
      const items = (await this.list(which)).filter((i) => !i.done);
      parts.push(`## ${LIST_TITLES[which]}`, ...(items.length ? items.map((i) => `- ${i.text}`) : ['(none)']), '');
    }
    const full = `${parts.join('\n').trimEnd()}\n`;
    if (full.length <= SNAPSHOT_LIMIT) return full;
    return full.slice(0, SNAPSHOT_LIMIT - SNAPSHOT_MARKER.length) + SNAPSHOT_MARKER;
  }
}
