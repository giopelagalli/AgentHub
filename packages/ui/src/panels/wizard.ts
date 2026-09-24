import type { ProjectManifest } from '@agenthub/shared';
import { getJson, sendJson } from '../api.js';
import {
  repoFieldMode, repoFieldNote, repoLabel, type GithubRepo, type GithubStatus,
} from '../github.js';
import { deriveSlug, repoProblem, slugProblem, wizardPayload, type Source } from '../newproject.js';
import { streamPost } from '../stream.js';

/**
 * The New Project wizard: a name, a slug, and one of three starting points — a paragraph to expand
 * into a PRD, a PRD to adopt, or a repository to import. Continue creates the project (cloning the
 * repository first, when there is one) and then drafts its PRD, streaming the draft into the same
 * card so the owner watches the document being written rather than a spinner.
 *
 * The same card, opened with `existing`, is the "draft one" flow for a project that has no PRD
 * yet: same source choice, same stream, no creation step.
 */

export interface WizardOptions {
  /** Draft into a project that already exists; the name and slug step is skipped. */
  existing?: { slug: string; title: string };
  /** The draft finished: the project to select, and the questions the drafter left open. */
  onDone: (slug: string, questions: string[]) => void;
}

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select, textarea, [href]';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, className = 'btn'): HTMLButtonElement {
  const node = el('button', className, label);
  node.type = 'button';
  return node;
}

/** A labelled field: the caption, the control, and room for a complaint under it. */
function field(label: string, control: HTMLElement): { wrap: HTMLElement; note: HTMLElement } {
  const wrap = el('label', 'field');
  const note = el('span', 'field__note');
  wrap.append(el('span', 'field__label', label), control, note);
  return { wrap, note };
}

export function openProjectWizard(host: HTMLElement, options: WizardOptions): () => void {
  const scrim = el('div', 'modal');
  scrim.setAttribute('role', 'dialog');
  scrim.setAttribute('aria-modal', 'true');
  const box = el('div', 'modal__box');
  scrim.appendChild(box);

  const heading = options.existing ? 'Draft a PRD' : 'New project';
  const subtitle = options.existing
    ? `${options.existing.title} — tell the drafter what it is`
    : 'Name it, then say what it is. The PRD gets drafted from there.';

  const head = el('header', 'modal__head');
  const headText = el('div');
  headText.append(el('h2', undefined, heading), el('p', 'modal__sub', subtitle));
  const close = button('×', 'drawer__close');
  close.title = 'Close (Esc)';
  head.append(headText, close);

  const body = el('div', 'modal__body');
  const foot = el('div', 'modal__foot');
  const problem = el('p', 'modal__error');
  problem.setAttribute('role', 'alert');
  const buttons = el('div', 'actions');
  foot.append(problem, buttons);
  box.append(head, body, foot);

  const say = (text: string): void => {
    problem.textContent = text;
    problem.classList.toggle('modal__error--on', !!text);
  };

  /** Where focus goes back to when the card closes. */
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  /** Aborts the draft when the card closes; null once the stream is over. */
  let draft: AbortController | null = null;
  let closed = false;
  /** The connected repositories the picker offers; empty until the status says there are any. */
  let repos: GithubRepo[] = [];

  const dispose = (): void => {
    if (closed) return;
    closed = true;
    draft?.abort();
    document.removeEventListener('keydown', onKey, true);
    scrim.remove();
    returnFocus?.focus();
  };

  // Esc closes; Tab cycles inside the card and nowhere else. Capture, so a control that stops the
  // event from bubbling can't let focus walk out into the page behind the scrim.
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') { event.preventDefault(); dispose(); return; }
    if (event.key !== 'Tab') return;
    const stops = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => !n.hidden && n.offsetParent !== null);
    if (!stops.length) return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !box.contains(active)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  close.addEventListener('click', dispose);
  scrim.addEventListener('mousedown', (event) => { if (event.target === scrim) dispose(); });
  document.addEventListener('keydown', onKey, true);

  // ---- step 1: what we are building -----------------------------------------------------------

  const name = el('input', 'input');
  name.placeholder = 'Acme Portal';
  const slug = el('input', 'input mono');
  slug.placeholder = 'acme-portal';
  slug.spellcheck = false;

  const nameField = field('Name', name);
  const slugField = field('Slug', slug);
  /** Until the owner edits the slug themselves, it follows the name. */
  let slugTouched = false;
  name.addEventListener('input', () => {
    if (!slugTouched) slug.value = deriveSlug(name.value);
    say('');
  });
  slug.addEventListener('input', () => {
    slugTouched = true;
    slugField.note.textContent = slug.value ? (slugProblem(slug.value) ?? '') : '';
    say('');
  });

  let source: Source = 'idea';
  const idea = el('textarea', 'input wizard__source');
  idea.rows = 9;
  const prd = el('textarea', 'input wizard__source');
  prd.rows = 9;
  prd.placeholder = '# Product requirements\n\nPaste the document you already have.';
  prd.hidden = true;

  // Import: the repository, the branch, and one line about how this hub reaches GitHub. Which of
  // the three ways in shows — a picker of connected repositories, the Connect button, or nothing
  // but the text box — is `repoFieldMode`; the text box is always there, so a repository the picker
  // does not list can still be typed and `repoProblem` still judges it.
  const repo = el('input', 'input mono');
  repo.placeholder = 'owner/repo';
  repo.spellcheck = false;
  const branch = el('input', 'input mono');
  branch.placeholder = 'default branch';
  branch.spellcheck = false;
  const repoField = field('Repository', repo);
  const branchField = field('Branch', branch);
  const picker = el('select', 'input');
  const pickerField = field('Repository', picker);
  pickerField.wrap.hidden = true;
  const connect = button('Connect GitHub', 'btn btn--primary');
  connect.hidden = true;
  const githubNote = el('p', 'modal__note', 'Private repos need a GitHub token on the hub.');
  const repoFields = el('div');
  const repoRow = el('div', 'wizard__row');
  repoRow.append(repoField.wrap, branchField.wrap);
  // The way in comes first — the picker, or the button and the line explaining it — and the typed
  // fields sit under it, because in every mode but `typed` they are the second-best way in.
  repoFields.append(pickerField.wrap, connect, githubNote, repoRow);
  repoFields.hidden = true;
  repo.addEventListener('input', () => {
    repoField.note.textContent = repo.value ? (repoProblem(repo.value) ?? '') : '';
    say('');
  });
  // Choosing from the picker fills the text box rather than replacing it, so what gets posted is
  // the same field either way — and the repository's own default branch becomes the placeholder,
  // which is exactly what leaving Branch blank means.
  picker.addEventListener('change', () => {
    const chosen = repos.find((r) => r.fullName === picker.value);
    if (!chosen) return;
    repo.value = chosen.fullName;
    repoField.note.textContent = '';
    branch.placeholder = chosen.defaultBranch;
    say('');
  });

  const choice = el('div', 'seg');
  choice.setAttribute('role', 'radiogroup');
  choice.setAttribute('aria-label', 'Where the PRD starts');
  const pick = (next: Source): void => {
    source = next;
    // The paragraph box serves both the idea and the import; only what it asks for changes.
    idea.hidden = next === 'prd';
    idea.placeholder = next === 'repo'
      ? 'What do you want done? A paragraph is enough.'
      : 'What do you want to build? A paragraph is enough.';
    prd.hidden = next !== 'prd';
    repoFields.hidden = next !== 'repo';
    for (const [id, node] of tabs) node.setAttribute('aria-checked', String(id === next));
    say('');
  };
  const tabs: [Source, HTMLButtonElement][] = ([
    ['idea', 'Start from an idea'],
    ['prd', 'Paste a PRD'],
    // Drafting into a project that already exists has nothing to import into.
    ...(options.existing ? [] : [['repo', 'Import a repo'] as [Source, string]]),
  ] as [Source, string][]).map(([id, label]) => {
    const node = button(label, 'seg__option');
    node.setAttribute('role', 'radio');
    node.addEventListener('click', () => pick(id));
    choice.appendChild(node);
    return [id, node];
  });

  const sourceField = el('div', 'field');
  sourceField.append(el('span', 'field__label', 'Where it starts'), choice, repoFields, idea, prd);

  const form = el('div', 'wizard');
  if (!options.existing) {
    const identity = el('div', 'wizard__row');
    identity.append(nameField.wrap, slugField.wrap);
    form.appendChild(identity);
  }
  form.appendChild(sourceField);

  const cancel = button('Cancel');
  cancel.addEventListener('click', dispose);
  const go = button(options.existing ? 'Draft PRD' : 'Continue', 'btn btn--primary');

  // ---- step 2: the draft being written --------------------------------------------------------

  const stream = el('pre', 'stream');
  stream.setAttribute('aria-live', 'polite');
  const streamNote = el('p', 'modal__note', 'Drafting the PRD…');

  const showStream = (): void => {
    body.replaceChildren(streamNote, stream);
    buttons.replaceChildren(cancel);
    cancel.focus();
  };

  const write = (token: string): void => {
    const following = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 12;
    stream.textContent += token;
    if (following) stream.scrollTop = stream.scrollHeight;
  };

  /**
   * The draft failed but the project is already there — offer the way in rather than stranding the
   * owner on a dead card, since the PRD view's own empty state can start the draft again.
   */
  const draftFailed = (slugValue: string, message: string): void => {
    draft = null;
    streamNote.textContent = 'The draft stopped early.';
    say(message);
    const open = button('Open the project', 'btn btn--primary');
    open.addEventListener('click', () => { const done = options.onDone; dispose(); done(slugValue, []); });
    buttons.replaceChildren(cancel, open);
    open.focus();
  };

  const runDraft = async (slugValue: string, text: string): Promise<void> => {
    showStream();
    const controller = new AbortController();
    draft = controller;
    try {
      // An import's paragraph is an idea as far as the drafter is concerned — what it adds is the
      // codebase, which the hub reads from the project itself rather than from this body.
      const done = await streamPost(
        `/api/projects/${slugValue}/prd/draft`, { [source === 'prd' ? 'prd' : 'idea']: text }, controller.signal, write,
      );
      draft = null;
      const questions = Array.isArray(done.questions) ? done.questions : [];
      const finish = options.onDone;
      dispose();
      finish(slugValue, questions);
    } catch (error) {
      if (controller.signal.aborted) return;
      draftFailed(slugValue, `Could not draft the PRD: ${String(error)}`);
    }
  };

  go.addEventListener('click', () => {
    const box = source === 'prd' ? prd : idea;
    const text = box.value.trim();
    if (!text) {
      say(source === 'prd' ? 'Paste the PRD first.'
        : source === 'repo' ? 'Say what you want done.' : 'Say what you want to build.');
      box.focus();
      return;
    }

    if (options.existing) {
      void runDraft(options.existing.slug, text);
      return;
    }

    const title = name.value.trim();
    if (!title) { say('A name is required.'); name.focus(); return; }
    const wanted = slug.value.trim() || deriveSlug(title);
    const bad = slugProblem(wanted);
    if (bad) { say(bad); slug.focus(); return; }
    if (source === 'repo') {
      const badRepo = repoProblem(repo.value);
      if (badRepo) { say(badRepo); repo.focus(); return; }
    }

    go.disabled = true;
    say('');
    // The hub clones before it answers, so this call carries the 400/502 a bad repository earns —
    // shown on the same error line as every other reason creation could fail.
    void sendJson('/api/projects', wizardPayload({
      source, slug: wanted, title, text, repo: repo.value, branch: branch.value,
    }))
      .then(() => runDraft(wanted, text))
      .catch((error: unknown) => {
        go.disabled = false;
        say(`Could not create the project: ${String(error)}`);
      });
  });

  buttons.append(cancel, go);
  body.appendChild(form);
  pick('idea');
  host.appendChild(scrim);
  (options.existing ? idea : name).focus();

  // How this hub reaches GitHub, and — when an App is connected — what it can reach. The hub
  // answers with accounts and repository names, never a token; a hub too old to know the route
  // simply leaves the line as it stands and the text box as the only way in.
  if (!options.existing) {
    void getJson<GithubStatus>('/api/github/status')
      .then(async (status) => {
        if (closed) return;
        const mode = repoFieldMode(status);
        githubNote.textContent = repoFieldNote(status);
        connect.hidden = mode !== 'connect';
        if (mode === 'connect') {
          const url = status.installUrl ?? '/api/github/connect';
          connect.addEventListener('click', () => { window.location.assign(url); });
        }
        if (mode !== 'picker') return;
        repos = await getJson<GithubRepo[]>('/api/github/repos');
        if (closed || !repos.length) return;
        picker.replaceChildren(el('option', undefined, 'Choose a repository…'));
        for (const item of repos) {
          const option = el('option', undefined, repoLabel(item));
          option.value = item.fullName;
          picker.appendChild(option);
        }
        pickerField.wrap.hidden = false;
        repoField.wrap.querySelector('.field__label')!.textContent = 'or type owner/repo';
      })
      .catch(() => { /* leave the note as the plain sentence */ });
  }

  // A re-draft for a project that already has an intake: prefill it, so a failed first draft
  // doesn't mean re-pasting the owner's idea or PRD.
  if (options.existing) {
    const slugValue = options.existing.slug;
    void getJson<{ manifest: ProjectManifest }>(`/api/projects/${slugValue}`)
      .then(({ manifest }) => {
        if (closed) return;
        const intake = manifest.intake;
        if (intake?.prd) {
          prd.value = intake.prd;
          pick('prd');
        } else if (intake?.idea) {
          idea.value = intake.idea;
          pick('idea');
        }
      })
      .catch(() => { /* no intake to prefill; the blank form still works */ });
  }

  return dispose;
}
