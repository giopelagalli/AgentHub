import './panels/panels.css';
import { PALETTE } from './art/palette.js';
import { SPRITES } from './art/sprites.js';
import { badgeLabel } from './badge.js';
import { Elevator, elevatorFrame } from './elevator.js';
import { bindPointer } from './engine/input.js';
import { startLoop } from './engine/loop.js';
import { Screen } from './engine/screen.js';
import { floorsFor } from './floors.js';
import { connect } from './net.js';
import { openChat } from './panels/chat.js';
import { closeDialog, dialogIsOpen, openDialog, tickDialog, type DialogChoice } from './panels/dialog.js';
import { openElevatorMenu } from './panels/elevator.js';
import { openNodeInfo } from './panels/nodeinfo.js';
import { openQueuePanel } from './panels/queue.js';
import { fetchProjectDetail, openTasksPanel } from './panels/tasks.js';
import { hotspotsFor } from './render/floorplans.js';
import { renderFloor } from './render/scene.js';
import { Store } from './store.js';

function hostElement(): HTMLElement {
  const element = document.getElementById('app');
  if (!element) throw new Error('#app host element not found');
  return element;
}

const app = hostElement();

// The panel stylesheet reads the canvas palette through these.
for (const [name, hex] of Object.entries(PALETTE)) {
  document.documentElement.style.setProperty(`--c-${name}`, hex);
}

const screen = new Screen(app);
const store = new Store();

const badge = document.createElement('div');
badge.className = 'gb-badge';
app.appendChild(badge);
store.subscribe((state) => {
  badge.textContent = badgeLabel(state.connection);
});
badge.textContent = badgeLabel(store.getState().connection);

/** Informational panels, newest last: Esc closes the one on top. */
const panels: (() => void)[] = [];

/** Returns a dismiss that closes the panel and drops it from the stack, once. */
function openPanel(close: () => void): () => void {
  const dismiss = (): void => {
    const index = panels.indexOf(dismiss);
    if (index >= 0) panels.splice(index, 1);
    close();
  };
  panels.push(dismiss);
  return dismiss;
}

function closeTopPanel(): void {
  panels[panels.length - 1]?.();
}

let closeMenu: (() => void) | null = null;

const elevator = new Elevator(store, (state) => {
  closeMenu?.();
  closeMenu = null;
  if (state.kind === 'menuOpen') {
    closeMenu = openElevatorMenu(
      document.body,
      floorsFor(store.getState()),
      store.getState().floor,
      (floor) => elevator.choose(floor),
    );
  }
});

/** One chat at a time: a second one would land on top of the first. */
let dismissChat: (() => void) | null = null;

async function greetAgent(agent: { id: number; name: string }): Promise<void> {
  const name = agent.name.toUpperCase();
  const busy = store.getState().busy.has(agent.id);
  const choice = await openDialog(
    app,
    [busy ? `${name} is hard at work!` : `${name} is taking a breather.`],
    busy
      ? [
          { id: 'watch', label: 'Watch' },
          { id: 'talk', label: 'Talk' },
          { id: 'close', label: 'Close' },
        ]
      : [
          { id: 'talk', label: 'Talk' },
          { id: 'close', label: 'Close' },
        ],
  );
  if (choice !== 'talk') return;
  dismissChat?.();
  dismissChat = openPanel(openChat(document.body, {
    name: agent.name,
    endpoint: `/api/agents/${agent.id}/messages`,
  }));
}

/** The reception desk is the assistant's spot: a greeting, then its own chat panel. */
async function greetAssistant(): Promise<void> {
  const choice = await openDialog(app, ['ASSISTANT', 'How can I help?'], [
    { id: 'talk', label: 'Talk' },
    { id: 'close', label: 'Close' },
  ]);
  if (choice !== 'talk') return;
  dismissChat?.();
  dismissChat = openPanel(openChat(document.body, {
    name: 'Assistant',
    endpoint: '/api/assistant/messages',
    pendingBase: '/api/assistant/pending',
  }));
}

const LINE_CHARS = 60;
const LINES_PER_PAGE = 4;

/** Greedy word-wrap into lines no longer than `maxChars`. */
function wrapLines(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

function paginate<T>(items: T[], size: number): T[][] {
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += size) pages.push(items.slice(i, i + size));
  return pages.length ? pages : [[]];
}

/** Shows `lines` as a sequence of dialog boxes, `LINES_PER_PAGE` at a time. */
async function showPaged(lines: string[]): Promise<void> {
  const pages = paginate(lines, LINES_PER_PAGE);
  for (let i = 0; i < pages.length; i++) {
    const last = i === pages.length - 1;
    const choices: DialogChoice[] = last ? [{ id: 'close', label: 'Close' }] : [{ id: 'next', label: 'Next' }];
    const choice = await openDialog(app, pages[i], choices);
    if (choice !== 'next') return;
  }
}

const BRIEF_CACHE_MS = 10 * 60 * 1000;
let briefingCache: { text: string; at: number } | null = null;

/** `POST /api/master/brief`, cached for `BRIEF_CACHE_MS` since it re-runs the master's loop. */
async function masterBriefingText(): Promise<string> {
  if (briefingCache && Date.now() - briefingCache.at < BRIEF_CACHE_MS) return briefingCache.text;
  const response = await fetch('/api/master/brief', { method: 'POST' });
  if (!response.ok) throw new Error(`hub replied ${response.status}`);
  const result = (await response.json()) as { text: string };
  briefingCache = { text: result.text, at: Date.now() };
  return briefingCache.text;
}

async function openMasterBriefingDialog(): Promise<void> {
  let text: string;
  try {
    text = await masterBriefingText();
  } catch (error) {
    text = `Could not load briefing: ${String(error)}`;
  }
  await showPaged(wrapLines(text, LINE_CHARS));
}

async function openProjectOrchestratorDialog(slug: string, title: string): Promise<void> {
  let summaryLines: string[];
  try {
    const detail = await fetchProjectDetail(slug);
    summaryLines = wrapLines(detail.briefing?.summary ?? 'No briefing yet.', LINE_CHARS).slice(0, 3);
  } catch (error) {
    summaryLines = [`Could not load briefing: ${String(error)}`];
  }

  const choice = await openDialog(app, [`${title.toUpperCase()} ORCHESTRATOR`, ...summaryLines], [
    { id: 'run', label: 'Run turn' },
    { id: 'close', label: 'Close' },
  ]);
  if (choice !== 'run') return;

  let resultLines: string[];
  try {
    const response = await fetch(`/api/projects/${slug}/turn`, { method: 'POST' });
    if (!response.ok) throw new Error(`hub replied ${response.status}`);
    const briefing = (await response.json()) as { summary?: string };
    resultLines = wrapLines(briefing.summary ?? 'Turn complete.', LINE_CHARS).slice(0, 3);
  } catch (error) {
    resultLines = [`Turn failed: ${String(error)}`];
  }
  await openDialog(app, resultLines, [{ id: 'close', label: 'Close' }]);
}

bindPointer(screen.canvas, (x, y) => {
  if (elevator.state.kind !== 'idle' || dialogIsOpen()) return;
  const state = store.getState();
  const spot = hotspotsFor(state.floor, state).find(
    (h) => x >= h.x && x < h.x + h.w && y >= h.y && y < h.y + h.h,
  );
  if (!spot) return;

  // The lobby directory board is a second call button for the same car.
  if (spot.id === 'elevator' || spot.id === 'directory') {
    elevator.open();
    return;
  }
  if (spot.id === 'jobboard') {
    openPanel(openQueuePanel(document.body, state));
    return;
  }
  if (spot.id === 'reception') {
    void greetAssistant();
    return;
  }
  if (spot.id === 'briefing') {
    void openMasterBriefingDialog();
    return;
  }
  if (spot.id.startsWith('project:board:')) {
    const slug = spot.id.slice('project:board:'.length);
    openPanel(openTasksPanel(document.body, slug));
    return;
  }
  if (spot.id.startsWith('project:orch:')) {
    const slug = spot.id.slice('project:orch:'.length);
    const project = state.hub?.projects?.find((p) => p.slug === slug);
    if (project) void openProjectOrchestratorDialog(slug, project.title);
    return;
  }
  if (spot.id.startsWith('project:sign:')) {
    const slug = spot.id.slice('project:sign:'.length);
    const project = state.hub?.projects?.find((p) => p.slug === slug);
    if (project) {
      void openDialog(
        app,
        [project.title.toUpperCase(), `Status: ${project.status}`, `Priority: ${project.priority}`],
        [{ id: 'close', label: 'Close' }],
      );
    }
    return;
  }
  if (spot.id.startsWith('rack:')) {
    const node = state.hub?.nodes.find((n) => n.name === spot.id.slice('rack:'.length));
    if (node) openPanel(openNodeInfo(document.body, node, state.hub?.streams ?? {}));
    return;
  }
  if (spot.id.startsWith('agent:')) {
    const id = Number(spot.id.slice('agent:'.length));
    const agent = state.hub?.agents.find((a) => a.id === id);
    if (agent) void greetAgent(agent);
  }
});

function typingInAnInput(): boolean {
  const element = document.activeElement;
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (dialogIsOpen()) closeDialog();
    else if (elevator.state.kind === 'menuOpen') elevator.cancel();
    else closeTopPanel();
    return;
  }
  // Shortcuts stay out of the way of the chat box, an open text screen, any
  // informational panel (chat/queue/nodeinfo), and the elevator's own menu —
  // riding the elevator underneath one of those would strand it.
  if (typingInAnInput() || dialogIsOpen() || panels.length > 0 || elevator.state.kind !== 'idle') return;
  // Number keys are shortcuts, not teleports: they ride the elevator too.
  const floor = floorsFor(store.getState())[Number(event.key) - 1];
  if (floor) elevator.choose(floor.id);
});

connect(store);

let tick = 0;

startLoop(
  (value) => {
    tick = value;
    elevator.tick();
    tickDialog(value);
  },
  () => {
    const state = store.getState();
    const ride = elevator.state;
    const doors = elevatorFrame(
      ride.kind,
      'ticks' in ride ? ride.ticks : 0,
      SPRITES.elevator.length,
    );
    renderFloor(screen.ctx, state.floor, state, tick, doors);
  },
);
