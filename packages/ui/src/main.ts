import './app.css';
import { badgeLabel } from './badge.js';
import { connect } from './net.js';
import { mountNav, type PageId } from './nav.js';
import { mountAllocation } from './pages/allocation.js';
import { mountCluster } from './pages/cluster.js';
import { mountComputer } from './pages/computer.js';
import { mountProjects } from './pages/projects.js';
import { openLoginPanel } from './panels/login.js';
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

const nav = document.createElement('aside');
nav.className = 'nav';
const brand = document.createElement('div');
brand.className = 'nav__brand';
brand.textContent = 'AgentHub';
nav.appendChild(brand);
mountNav(nav, store);

const foot = document.createElement('div');
foot.className = 'nav__foot';
const badge = document.createElement('span');
badge.className = 'badge';
foot.appendChild(badge);
nav.appendChild(foot);

const page = document.createElement('main');
page.className = 'page';
app.append(nav, page);

store.subscribe((state) => {
  badge.textContent = badgeLabel(state.connection);
  badge.dataset.status = state.connection;
});
badge.textContent = badgeLabel(store.getState().connection);
badge.dataset.status = store.getState().connection;

/** The page on screen, swapped whole when the nav selection changes. */
let showing: PageId | null = null;
let teardown: (() => void) | null = null;

store.subscribe((state) => {
  if (state.page === showing) return;
  showing = state.page;
  teardown?.();
  page.replaceChildren();
  teardown = MOUNTS[state.page](page, store);
});
showing = store.getState().page;
teardown = MOUNTS[showing](page, store);

/**
 * The hub answers 401 to everything but the login route once it has a password, so ask who we are
 * before wiring anything up: a 401 puts the login box over the empty app and boots again once it
 * closes. Any other answer (200, or a 404 from a hub predating this route) means we may proceed;
 * an unreachable hub does too, and `connect` reports it as down.
 */
async function boot(): Promise<void> {
  const me = await fetch('/api/me', { credentials: 'same-origin' }).catch(() => null);
  if (me?.status === 401) {
    openLoginPanel(document.body, () => { void boot(); });
    return;
  }
  connect(store);
}

void boot();
