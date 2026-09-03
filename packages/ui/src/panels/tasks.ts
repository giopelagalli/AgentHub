export type TaskStatus = 'backlog' | 'in-progress' | 'done' | 'blocked';

export interface TaskItem {
  id: string;
  title: string;
  status: TaskStatus;
  owner?: string;
  notes?: string;
}

export interface BriefingSummary {
  summary: string;
  progress: { done: number; total: number };
}

export interface ProjectDetail {
  manifest: { slug: string; title: string; status: string; priority: string };
  briefing: BriefingSummary | null;
  tasks: TaskItem[];
}

/** `GET /api/projects/:slug` — manifest, latest briefing, and the task list. */
export async function fetchProjectDetail(slug: string, signal?: AbortSignal): Promise<ProjectDetail> {
  const response = await fetch(`/api/projects/${slug}`, { signal });
  if (!response.ok) throw new Error(`hub replied ${response.status}`);
  return (await response.json()) as ProjectDetail;
}

const GROUPS: { status: TaskStatus; label: string }[] = [
  { status: 'backlog', label: 'Backlog' },
  { status: 'in-progress', label: 'In progress' },
  { status: 'done', label: 'Done' },
  { status: 'blocked', label: 'Blocked' },
];

function renderDetail(body: HTMLElement, detail: ProjectDetail): void {
  body.textContent = '';

  const summary = document.createElement('p');
  summary.textContent = detail.briefing?.summary ?? 'No briefing yet.';
  body.appendChild(summary);

  if (detail.briefing) {
    const progress = document.createElement('p');
    progress.className = 'gb-hint';
    progress.textContent = `Progress: ${detail.briefing.progress.done}/${detail.briefing.progress.total}`;
    body.appendChild(progress);
  }

  for (const group of GROUPS) {
    const items = detail.tasks.filter((t) => t.status === group.status);

    const heading = document.createElement('h3');
    heading.textContent = `${group.label} (${items.length})`;
    body.appendChild(heading);

    if (items.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'gb-hint';
      empty.textContent = 'None';
      body.appendChild(empty);
      continue;
    }

    const table = document.createElement('table');
    const tbody = table.createTBody();
    for (const task of items) {
      const row = tbody.insertRow();
      row.insertCell().textContent = task.title;
      row.insertCell().textContent = task.owner ?? '—';
    }
    body.appendChild(table);
  }
}

/** The project floor's task board: `GET /api/projects/:slug`, grouped by status. */
export function openTasksPanel(host: HTMLElement, slug: string): () => void {
  const panel = document.createElement('div');
  panel.className = 'gb-panel gb-panel--center';

  const heading = document.createElement('h2');
  heading.textContent = 'Task board';
  panel.appendChild(heading);

  const body = document.createElement('div');
  body.textContent = 'Loading…';
  panel.appendChild(body);

  const hint = document.createElement('p');
  hint.className = 'gb-hint';
  hint.textContent = 'Esc to close';
  panel.appendChild(hint);

  host.appendChild(panel);

  const controller = new AbortController();
  void fetchProjectDetail(slug, controller.signal)
    .then((detail) => renderDetail(body, detail))
    .catch((error: unknown) => {
      if (controller.signal.aborted) return;
      body.textContent = `Failed to load: ${String(error)}`;
    });

  return () => {
    controller.abort();
    panel.remove();
  };
}
