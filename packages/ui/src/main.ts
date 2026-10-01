import './styles/tokens.css';
import './styles/controls.css';
import './app.css';
import './styles/shell.css';
import './styles/project.css';
import './styles/sheets.css';
import './styles/docs.css';
import './styles/workspace.css';
import './styles/machines.css';
import './styles/drawer.css';
import './styles/media.css';
import { githubReturn, withoutGithubParam } from './github.js';
import { connect } from './net.js';
import { mountHelp } from './pages/help.js';
import { mountMachines } from './pages/machines.js';
import { mountProjects } from './pages/projects.js';
import { openLoginPanel } from './panels/login.js';
import { mountRail, placeOf, type PageId } from './rail.js';
import { Store } from './store.js';
import { toast } from './toast.js';

/**
 * The three places the main area can hold. Machines' four sections are one place: moving between
 * them is the page's own business, so the shell only remounts when the place itself changes.
 */
type Place = 'projects' | 'machines' | 'help';

const placeFor = (page: PageId): Place => (page === 'projects' ? 'projects' : placeOf(page) ?? 'projects');

/** Every place mounts into the same host and hands back its own teardown. */
const MOUNTS: Record<Place, (host: HTMLElement, store: Store) => () => void> = {
  projects: mountProjects,
  machines: mountMachines,
  help: mountHelp,
};

function hostElement(): HTMLElement {
  const element = document.getElementById('app');
  if (!element) throw new Error('#app host element not found');
  return element;
}

const app = hostElement();
const store = new Store();

const rail = document.createElement('aside');
rail.className = 'sidebar';

const page = document.createElement('main');
page.className = 'page';
app.append(rail, page);

mountRail(rail, store, {
  onLayout: ({ collapsed, drawerOpen }) => {
    app.classList.toggle('app--collapsed', collapsed);
    app.classList.toggle('app--drawer', drawerOpen);
  },
});

/** The place on screen, swapped whole when the sidebar selection changes. */
let showing: Place | null = null;
let teardown: (() => void) | null = null;

store.subscribe((state) => {
  if (teardown === null) return;
  const next = placeFor(state.page);
  if (next === showing) return;
  showing = next;
  teardown();
  page.replaceChildren();
  teardown = MOUNTS[next](page, store);
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
    showing = placeFor(store.getState().page);
    teardown = MOUNTS[showing](page, store);
  }
  connect(store);
  // Back from GitHub's install screen. Say so once and take the parameter off the address bar, so
  // a reload doesn't toast again.
  if (githubReturn(window.location.search)) {
    toast('GitHub connected. Its repositories are in New project → Import from GitHub.');
    window.history.replaceState(null, '', withoutGithubParam(window.location.href));
  }
  // Dev harness: `?fake-turns` (or `=idle`, `=long`) plays scripted turn frames into the store.
  // The import is behind `DEV`, so a production build carries none of it.
  if (import.meta.env.DEV) {
    const fake = new URLSearchParams(window.location.search).get('fake-turns');
    if (fake !== null) void import('./fixtures/turns.js').then((m) => m.injectFakeTurns(store, fake));
  }
}

void boot();
