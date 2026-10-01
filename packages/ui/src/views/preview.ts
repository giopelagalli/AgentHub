import type { PreviewStatus } from '@agenthub/shared';
import { getJson, sendJson } from '../api.js';
import { button, el } from '../dom.js';
import { toast } from '../toast.js';
import { note, type ViewContext } from './parts.js';

/**
 * The preview sheet (FR-B1): the project's own app in an iframe, with the controls that start and
 * stop it and the log tail that says why it isn't up when it isn't.
 *
 * The app is served from the hub's preview listener — a different origin (0040), which is what
 * keeps project code out of the session. The iframe is therefore genuinely sandboxed, and the URL
 * carries a capability the owner can reset from here.
 */

/** How often the sheet re-reads the status while it is open. */
const POLL_MS = 5000;

export type PreviewPhase = 'unconfigured' | 'running' | 'stopped' | 'crashed';

/** Which of the four states a status describes. Pure — the pill, the buttons and the tests read it. */
export function previewPhase(status: PreviewStatus | null): PreviewPhase {
  if (!status?.configured) return 'unconfigured';
  if (status.running) return 'running';
  return status.crashed ? 'crashed' : 'stopped';
}

const PHASE_TEXT: Record<PreviewPhase, string> = {
  unconfigured: 'Not configured',
  running: 'Running',
  stopped: 'Stopped',
  crashed: 'Crashed',
};

/** What the status pill says: the phase, and the port where there is one. */
export function previewStatusText(status: PreviewStatus | null): string {
  const phase = previewPhase(status);
  if (phase === 'running') return `Running on :${status?.port}`;
  return PHASE_TEXT[phase];
}

/** Where the iframe points: the preview's own origin plus the app path the config asked for. */
export function previewSrc(status: PreviewStatus): string | null {
  if (!status.url) return null;
  const path = status.config?.path ?? '/';
  return `${status.url}${path.replace(/^\//, '')}`;
}

/** The command as one editable line. Argv is split on whitespace, so quoted arguments aren't a thing. */
const commandLine = (status: PreviewStatus | null): string => (status?.config?.cmd ?? []).join(' ');

export function mountPreview(host: HTMLElement, ctx: ViewContext): () => void {
  let status: PreviewStatus | null = null;
  let state: 'loading' | 'ready' | 'failed' = 'loading';
  let settingsOpen = false;
  /** Bumped on every reload the iframe should actually make, so polling never reloads the app. */
  let frameKey = '';
  let alive = true;
  let timer: ReturnType<typeof setInterval> | undefined;

  const root = el('div', 'preview');
  const bar = el('div', 'preview__bar');
  const pill = el('span', 'preview__pill');
  const actions = el('div', 'actions');
  const settingsBox = el('form', 'preview__settings');
  const stage = el('div', 'preview__stage');
  const frame = el('iframe', 'preview__frame');
  // Scripts and same-origin so a dev server's client code and its hot reload work; the preview is
  // the owner's own app, served from the hub's origin, and nothing else is granted.
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals');
  const logBox = el('pre', 'preview__log');
  // The page's bar under the toolbar takes this view's bar when it offers one.
  if (ctx.actions) {
    ctx.actions.replaceChildren(bar);
    root.append(settingsBox, stage, logBox);
  } else root.append(bar, settingsBox, stage, logBox);
  host.appendChild(root);

  const act = (action: 'start' | 'stop' | 'restart'): void => {
    void sendJson<PreviewStatus>(`/api/projects/${ctx.slug}/preview/${action}`)
      .then((next) => {
        if (!alive) return;
        if (next) { status = next; state = 'ready'; }
        render();
      })
      .catch((error: unknown) => toast(`Could not ${action} the preview: ${String(error)}`, 'error'));
  };

  const load = (): void => {
    void getJson<PreviewStatus>(`/api/projects/${ctx.slug}/preview`)
      .then((next) => { if (alive) { status = next; state = 'ready'; render(); } })
      .catch(() => { if (alive) { state = 'failed'; render(); } });
  };

  const save = (cmd: string[], port: number, path: string): void => {
    const body = { cmd, port, ...(path ? { path } : {}) };
    void sendJson<PreviewStatus>(`/api/projects/${ctx.slug}/preview`, body, 'PUT')
      .then((next) => {
        if (!alive) return;
        if (next) { status = next; state = 'ready'; }
        settingsOpen = false;
        renderSettings();
        render();
        toast('Preview saved');
      })
      .catch((error: unknown) => toast(`Could not save the preview: ${String(error)}`, 'error'));
  };

  /** A new capability: the old address stops working, and the preview stops with it. */
  const rotate = (): void => {
    void sendJson<PreviewStatus>(`/api/projects/${ctx.slug}/preview/rotate`)
      .then((next) => {
        if (!alive) return;
        if (next) { status = next; state = 'ready'; }
        renderSettings();
        render();
        toast('Preview link reset');
      })
      .catch((error: unknown) => toast(`Could not reset the link: ${String(error)}`, 'error'));
  };

  /** The settings form: the command, the port and the path, written straight to the manifest. */
  function renderSettings(): void {
    settingsBox.replaceChildren();
    settingsBox.hidden = !settingsOpen;
    if (!settingsOpen) return;
    const cmd = el('input');
    cmd.value = commandLine(status);
    cmd.placeholder = 'npm run dev';
    const port = el('input');
    port.type = 'number';
    port.value = String(status?.config?.port ?? 5173);
    const path = el('input');
    path.value = status?.config?.path ?? '';
    path.placeholder = '/';
    const submit = button('Save', 'btn btn--primary');
    submit.type = 'submit';
    for (const [label, input, hint] of [
      ['Command', cmd, 'Run in the project workspace; split on spaces.'],
      ['Port', port, 'The port the dev server listens on.'],
      ['Path', path, 'Where the preview opens inside the app.'],
    ] as [string, HTMLElement, string][]) {
      const field = el('label', 'preview__field');
      field.append(el('span', 'preview__label', label), input, el('span', 'preview__hint', hint));
      settingsBox.appendChild(field);
    }
    const link = el('label', 'preview__field');
    const address = el('input');
    address.value = status?.url ?? '';
    address.readOnly = true;
    address.placeholder = 'Saved previews get their own address.';
    const reset = button('Reset link');
    reset.addEventListener('click', () => {
      if (!window.confirm('Reset the preview link? The current address stops working and the preview is stopped.')) return;
      rotate();
    });
    link.append(
      el('span', 'preview__label', 'Address'), address,
      el('span', 'preview__hint', 'Its own origin, with a secret in the path — anyone holding it can open the app.'),
    );
    settingsBox.append(link, reset, submit);
    settingsBox.onsubmit = (event) => {
      event.preventDefault();
      const argv = cmd.value.trim().split(/\s+/).filter(Boolean);
      if (!argv.length) return toast('The command cannot be empty', 'error');
      const parsed = Number(port.value);
      if (!Number.isInteger(parsed)) return toast('The port must be a whole number', 'error');
      return save(argv, parsed, path.value.trim());
    };
  }

  function render(): void {
    const phase = previewPhase(status);
    pill.textContent = state === 'failed' ? 'Unreachable' : previewStatusText(status);
    pill.className = `preview__pill preview__pill--${state === 'failed' ? 'crashed' : phase}`;

    actions.replaceChildren();
    if (phase !== 'unconfigured') {
      const toggle = button(phase === 'running' ? 'Stop' : 'Start');
      toggle.addEventListener('click', () => act(phase === 'running' ? 'stop' : 'start'));
      const restart = button('Restart');
      restart.disabled = phase !== 'running';
      restart.addEventListener('click', () => act('restart'));
      actions.append(toggle, restart);
      const src = status && phase === 'running' ? previewSrc(status) : null;
      if (src) {
        const open = el('a', 'btn', 'Open in tab');
        open.href = src;
        open.target = '_blank';
        open.rel = 'noreferrer';
        actions.appendChild(open);
      }
    }
    const settings = button(settingsOpen ? 'Close settings' : 'Settings');
    settings.setAttribute('aria-expanded', String(settingsOpen));
    settings.addEventListener('click', () => { settingsOpen = !settingsOpen; renderSettings(); render(); });
    actions.appendChild(settings);
    bar.replaceChildren(pill, actions);

    stage.replaceChildren();
    const running = status && phase === 'running' ? previewSrc(status) : null;
    if (running) {
      // Only re-pointed when the address actually changed: a poll that reassigned `src` would
      // reload the app under the owner every five seconds.
      const key = `${running}#${status?.startedAt ?? 0}`;
      if (key !== frameKey) { frameKey = key; frame.setAttribute('src', running); }
      stage.appendChild(frame);
    } else {
      frameKey = '';
      stage.appendChild(note(
        phase === 'unconfigured'
          ? 'No preview yet. Open Settings and say how this project\'s app is run.'
          : phase === 'crashed' ? 'The preview stopped on its own — its last lines are below.' : 'The preview is stopped.',
        phase === 'crashed' ? 'error' : 'empty',
      ));
    }

    const lines = status?.log ?? [];
    logBox.textContent = lines.length ? lines.join('\n') : 'No output yet.';
    logBox.scrollTop = logBox.scrollHeight;
  }

  renderSettings();
  render();
  load();
  timer = setInterval(load, POLL_MS);

  return () => {
    alive = false;
    if (timer) clearInterval(timer);
  };
}
