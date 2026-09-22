import './app.css';
import { connect } from './net.js';
import { mountAllocation } from './pages/allocation.js';
import { mountCluster } from './pages/cluster.js';
import { mountComputer } from './pages/computer.js';
import { mountProjects } from './pages/projects.js';
import { openLoginPanel } from './panels/login.js';
import { mountRail, type PageId } from './rail.js';
import { Store } from './store.js';

/** Every page mounts into the same host and hands back its own teardown. */
const MOUNTS: Record<PageId, (host: HTMLElement, store: Store) => () => void> = {
  projects: mountProjects,
  computer: mountComputer,
  cluster: mountCluster,
  allocation: mountAllocation,
};

function hostElement(): HTMLElement {
  const element = document.getElementById('app');
  if (!element) throw new Error('#app host element not found');
  return element;
}

const app = hostElement();
const store = new Store();

const rail = document.createElement('aside');
rail.className = 'rail';

const page = document.createElement('main');
page.className = 'page';
app.append(rail, page);

mountRail(rail, store, {
  onCollapsed: (collapsed) => app.classList.toggle('app--tight', collapsed),
});

/** The page on screen, swapped whole when the rail selection changes. */
let showing: PageId | null = null;
let teardown: (() => void) | null = null;

store.subscribe((state) => {
  if (state.page === showing) return;
  showing = state.page;
  teardown?.();
  page.replaceChildren();
  teardown = MOUNTS[state.page](page, store);
});

/**
 * The hub answers 401 to everything but the login route once it has a password, so ask who we are
 * before wiring anything up: a 401 puts the login box over the empty app and boots again once it
 * closes. Any other answer (200, or a 404 from a hub predating this route) means we may proceed;
 * an unreachable hub does too, and `connect` reports it as down. The first page mounts only
 * after this check: its own fetches go through `request`, which reloads on a 401 — mounting
 * before we know we are logged in would loop the page through reload → 401 → reload.
 */
async function boot(): Promise<void> {
  const me = await fetch('/api/me', { credentials: 'same-origin' }).catch(() => null);
  if (me?.status === 401) {
    openLoginPanel(document.body, () => { void boot(); });
    return;
  }
  if (teardown === null) {
    showing = store.getState().page;
    teardown = MOUNTS[showing](page, store);
  }
  connect(store);
  // Dev harness: `?fake-turns` (or `=idle`, `=long`) plays scripted turn frames into the store.
  // The import is behind `DEV`, so a production build carries none of it.
  if (import.meta.env.DEV) {
    const fake = new URLSearchParams(window.location.search).get('fake-turns');
    if (fake !== null) void import('./fixtures/turns.js').then((m) => m.injectFakeTurns(store, fake));
  }
}

void boot();
