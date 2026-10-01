import type { Priority, ProjectStatus } from '@agenthub/shared';
import { getJson, sendJson } from '../api.js';
import { toast } from '../toast.js';
import { drawerHeader } from './chat.js';

/** `GET /api/briefings` — the latest briefing each project has published. */
export interface Briefing {
  slug: string;
  title: string;
  status: ProjectStatus;
  priority: Priority;
  summary: string;
  progress: { done: number; total: number };
  blockers: string[];
  nextSteps: string[];
  updatedAt: number;
}

function list(label: string, items: string[]): HTMLElement | null {
  if (!items.length) return null;
  const wrap = document.createElement('div');
  const heading = document.createElement('h4');
  heading.textContent = label;
  const ul = document.createElement('ul');
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = item;
    ul.appendChild(li);
  }
  wrap.append(heading, ul);
  return wrap;
}

function briefingCard(briefing: Briefing): HTMLElement {
  const card = document.createElement('article');
  card.className = 'brief';

  const head = document.createElement('h3');
  head.textContent = briefing.title;
  const meta = document.createElement('p');
  meta.className = 'brief__meta';
  meta.textContent = `${briefing.status} · ${briefing.priority} · ${briefing.progress.done}/${briefing.progress.total} done`;
  const summary = document.createElement('p');
  summary.className = 'brief__summary';
  summary.textContent = briefing.summary;

  card.append(head, meta, summary);
  for (const block of [list('Blockers', briefing.blockers), list('Next', briefing.nextSteps)]) {
    if (block) card.appendChild(block);
  }
  return card;
}

export interface MasterPanelOptions {
  /**
   * The drawer has gone, whichever way it was closed — its ×, Escape, or the handle the caller
   * holds. The same contract as `ChatTarget.onClose`, so a caller tracking which drawer is open
   * hears about this one on every route rather than only the one it drove itself.
   */
  onClose?: () => void;
}

/**
 * The master's drawer: read-only. What it publishes is the briefings every
 * project orchestrator filed, and the one lever is asking it to run a fresh
 * daily briefing over them.
 */
export function openMasterPanel(host: HTMLElement, options: MasterPanelOptions = {}): () => void {
  const panel = document.createElement('aside');
  panel.className = 'drawer';

  const body = document.createElement('div');
  body.className = 'drawer__body';

  const actions = document.createElement('div');
  actions.className = 'actions';
  const brief = document.createElement('button');
  brief.type = 'button';
  brief.className = 'btn btn--primary';
  brief.textContent = 'Daily briefing';
  actions.appendChild(brief);

  // The × below, Escape, and the handle returned to the caller all land here, so the guard is what
  // makes `onClose` fire exactly once however many of them are used.
  let closed = false;
  const dispose = (): void => {
    if (closed) return;
    closed = true;
    window.removeEventListener('keydown', onKey);
    panel.remove();
    options.onClose?.();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') dispose();
  };
  window.addEventListener('keydown', onKey);
  panel.append(drawerHeader('Master', 'Reads every project’s briefing', dispose, 'robot-magenta'), actions, body);

  const say = (text: string): void => {
    body.replaceChildren();
    const line = document.createElement('p');
    line.className = 'empty';
    line.textContent = text;
    body.appendChild(line);
  };

  const load = async (): Promise<void> => {
    say('Loading briefings…');
    try {
      const briefings = await getJson<Briefing[]>('/api/briefings');
      if (!briefings.length) return say('No project has published a briefing yet.');
      body.replaceChildren(...briefings.map(briefingCard));
    } catch (error) {
      say(`Could not load briefings: ${String(error)}`);
    }
  };

  brief.addEventListener('click', () => {
    brief.disabled = true;
    brief.textContent = 'Briefing…';
    void sendJson<{ text: string }>('/api/master/brief')
      .then((result) => toast(result?.text ?? 'Briefing done.'))
      .catch((error: unknown) => toast(`Briefing failed: ${String(error)}`, 'error'))
      .finally(() => {
        brief.disabled = false;
        brief.textContent = 'Daily briefing';
        void load();
      });
  });

  host.appendChild(panel);
  void load();
  return dispose;
}
