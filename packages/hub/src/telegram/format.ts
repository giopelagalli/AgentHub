import type { NodeInfo } from '@agenthub/shared';
import type { PlannerList } from '../assistant/planner.js';
import type { Briefing } from '../projects/schema.js';
import type { InlineButton, OutgoingMessage } from './port.js';

const LIST_TITLES: Record<PlannerList, string> = { goals: 'Goals', todo: 'Todo', backlog: 'Backlog' };

export function formatProjects(briefings: Briefing[]): OutgoingMessage {
  if (!briefings.length) return { text: 'No projects have published a briefing yet.' };
  const lines = briefings.map((b) =>
    `${b.title} (${b.slug}) — ${b.status}, ${b.priority}, ${b.progress.done}/${b.progress.total} done`);
  const buttons: InlineButton[][] = briefings.map((b) => [
    b.status === 'paused'
      ? { text: 'Resume', data: `proj:resume:${b.slug}` }
      : { text: 'Pause', data: `proj:pause:${b.slug}` },
    { text: 'Run turn', data: `proj:turn:${b.slug}` },
  ]);
  return { text: lines.join('\n'), buttons };
}

export function formatBriefing(text: string, briefings: Briefing[]): OutgoingMessage {
  if (!briefings.length) return { text };
  const lines = briefings.map((b) => `- ${b.title}: ${b.status}, ${b.progress.done}/${b.progress.total} done`);
  return { text: [text, '', ...lines].join('\n') };
}

export function formatNodes(nodes: NodeInfo[], streams: Record<string, number>): OutgoingMessage {
  if (!nodes.length) return { text: 'No nodes registered.' };
  const lines = nodes.map((n) =>
    `${n.name} (${n.arch}) — ${n.status}, tiers: ${n.endpoints.map((e) => e.tier).join(', ') || 'none'}`);
  const streamEntries = Object.entries(streams);
  const streamLines = streamEntries.map(([tier, count]) => `${tier}: ${count} active`);
  return { text: [...lines, ...(streamLines.length ? ['', ...streamLines] : [])].join('\n') };
}

export function formatPlanner(which: PlannerList, items: { n: number; text: string; done: boolean }[]): OutgoingMessage {
  const title = LIST_TITLES[which];
  if (!items.length) return { text: `${title}: (empty)` };
  const lines = items.map((i) => `${i.n}. [${i.done ? 'x' : ' '}] ${i.text}`);
  return { text: [`${title}:`, ...lines].join('\n') };
}

/**
 * Splits `text` on paragraph boundaries so no piece exceeds `max` chars. A single paragraph longer
 * than `max` is hard-split — Telegram still needs every message under its own length cap.
 */
export function splitMessage(text: string, max = 3500): string[] {
  if (text.length <= max) return [text];
  const paragraphs = text.split(/\n{2,}/);
  const parts: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= max) {
      current = candidate;
      continue;
    }
    if (current) parts.push(current);
    if (paragraph.length <= max) {
      current = paragraph;
    } else {
      for (let i = 0; i < paragraph.length; i += max) parts.push(paragraph.slice(i, i + max));
      current = '';
    }
  }
  if (current) parts.push(current);
  return parts;
}
