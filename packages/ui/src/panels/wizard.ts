import type { ProjectManifest } from '@agenthub/shared';
import { getJson, sendJson } from '../api.js';
import { button, el } from '../dom.js';
import {
  repoFieldMode, repoFieldNote, repoLabel, type GithubRepo, type GithubStatus,
} from '../github.js';
import { icon, type IconName } from '../icons.js';
import { deriveSlug, repoProblem, slugProblem, wizardPayload, type Source } from '../newproject.js';
import { streamPost } from '../stream.js';
import { openModal } from './modal.js';

/**
 * The New project sheet. Three big choices first — describe an idea, paste a PRD, import from
 * GitHub — then one thing at a time: the name, then what the PRD starts from. Create makes the
 * project (cloning the repository first, when there is one) and then drafts its PRD, streaming the
 * draft into the same sheet so the owner watches the document being written rather than a spinner.
 *
 * The same sheet, opened with `existing`, is the "draft one" flow for a project that has no PRD
 * yet: the same choice (without the import), the same stream, no name and no creation step.
 */

export interface WizardOptions {
  /** Draft into a project that already exists; the name step is skipped. */
  existing?: { slug: string; title: string };
  /** The draft finished: the project to select, and the questions the drafter left open. */
  onDone: (slug: string, questions: string[]) => void;
}

type Step = 'choose' | 'name' | 'source' | 'draft';

const CHOICES: { id: Source; icon: IconName; title: string; line: string }[] = [
  { id: 'idea', icon: 'sparkle', title: 'Describe an idea', line: 'A paragraph is enough — the PRD is drafted from it.' },
  { id: 'prd', icon: 'doc', title: 'Paste a PRD', line: 'Bring the requirements you already have.' },
  { id: 'repo', icon: 'branch', title: 'Import from GitHub', line: 'Start from a repository’s code and say what to do with it.' },
];

/** A labelled field: the caption, the control, and room for a complaint under it. */
function field(label: string, control: HTMLElement, hint?: string): { wrap: HTMLElement; note: HTMLElement; label: HTMLElement } {
  const wrap = el('label', 'field');
  const caption = el('span', 'field__label', label);
  const note = el('span', 'field__note');
  wrap.append(caption, control);
  if (hint) wrap.appendChild(el('span', 'field__hint', hint));
  wrap.appendChild(note);
  return { wrap, note, label: caption };
}

export function openProjectWizard(host: HTMLElement, options: WizardOptions): () => void {
  /** Aborts the draft when the sheet closes; null once the stream is over. */
  let draft: AbortController | null = null;
  let closed = false;
  const modal = openModal(host, {
    className: 'wizard-sheet',
    label: options.existing ? 'Draft a PRD' : 'New project',
    onClose: () => { closed = true; draft?.abort(); },
  });
  const dispose = modal.close;

  const head = el('header', 'wizard__head');
  const back = button('', 'btn btn--icon wizard__back');
  back.appendChild(icon('chevronLeft', 18));
  back.setAttribute('aria-label', 'Back');
  back.title = 'Back';
  const titles = el('div', 'wizard__titles');
  const heading = el('h2');
  const subtitle = el('p', 'wizard__sub');
  titles.append(heading, subtitle);
  const close = button('', 'btn btn--icon');
  close.appendChild(icon('close', 16));
  close.title = 'Close (Esc)';
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', dispose);
  head.append(back, titles, close);

  const body = el('div', 'wizard__body');
  const foot = el('div', 'wizard__foot');
  const problem = el('p', 'wizard__error');
  problem.setAttribute('role', 'alert');
  const buttons = el('div', 'actions');
  foot.append(problem, buttons);
  modal.box.append(head, body, foot);

  const say = (text: string): void => {
    problem.textContent = text;
    problem.hidden = !text;
  };

  /** The connected repositories the picker offers; empty until the status says there are any. */
  let repos: GithubRepo[] = [];
  let source: Source = 'idea';
  let step: Step = 'choose';

  // ---- the fields, built once so what was typed survives going back and forth ----------------

  const name = el('input', 'input input--large');
  name.placeholder = 'Acme Portal';
  name.autocomplete = 'off';
  const slug = el('input', 'input mono');
  slug.placeholder = 'acme-portal';
  slug.spellcheck = false;
  const nameField = field('Name', name);
  const slugField = field('Short name', slug, 'Used in the project’s address and folder. Lowercase letters, digits and dashes.');
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

  const idea = el('textarea', 'input wizard__source');
  idea.rows = 8;
  const prd = el('textarea', 'input wizard__source mono');
  prd.rows = 12;
  prd.placeholder = '# Product requirements\n\nPaste the document you already have.';
  const ideaField = field('What do you want to build?', idea);
  const prdField = field('The PRD', prd, 'Markdown is best; the drafter tidies it into the house format and lists what it still needs.');

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
  const picker = el('select', 'select');
  const pickerField = field('Repository', picker);
  pickerField.wrap.hidden = true;
  const connect = button('', 'btn');
  connect.append(icon('branch', 15), document.createTextNode('Connect GitHub'));
  connect.hidden = true;
  const githubNote = el('p', 'wizard__note', 'Private repositories need a GitHub token on the hub.');
  const repoRow = el('div', 'wizard__row');
  repoRow.append(repoField.wrap, branchField.wrap);
  const repoFields = el('div', 'wizard__group');
  // The way in comes first — the picker, or the button and the line explaining it — and the typed
  // fields sit under it, because in every mode but `typed` they are the second-best way in.
  repoFields.append(pickerField.wrap, connect, githubNote, repoRow);
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

  // ---- the steps -----------------------------------------------------------------------------

  const cancel = button('Cancel');
  cancel.addEventListener('click', dispose);
  const go = button('', 'btn btn--primary');

  const choices = options.existing ? CHOICES.filter((c) => c.id !== 'repo') : CHOICES;

  const show = (next: Step): void => {
    step = next;
    say('');
    back.hidden = next === 'choose' || next === 'draft' || (next === 'source' && !!options.existing && choices.length < 2);
    modal.box.dataset.step = next;
    body.replaceChildren();
    buttons.replaceChildren();

    if (next === 'choose') {
      heading.textContent = options.existing ? 'Draft a PRD' : 'New project';
      subtitle.textContent = options.existing ? `${options.existing.title} — where does it start?` : 'How do you want to start?';
      const list = el('div', 'choices');
      list.setAttribute('role', 'list');
      for (const choice of choices) {
        const card = button('', 'choice');
        card.setAttribute('role', 'listitem');
        const badge = el('span', 'choice__icon');
        badge.appendChild(icon(choice.icon, 22));
        const text = el('span', 'choice__text');
        text.append(el('span', 'choice__title', choice.title), el('span', 'choice__line', choice.line));
        card.append(badge, text, icon('chevronRight', 16));
        card.addEventListener('click', () => {
          source = choice.id;
          show(options.existing ? 'source' : 'name');
        });
        list.appendChild(card);
      }
      body.appendChild(list);
      buttons.append(cancel);
      queueMicrotask(() => list.querySelector<HTMLElement>('.choice')?.focus());
      return;
    }

    if (next === 'name') {
      heading.textContent = 'Name it';
      subtitle.textContent = CHOICES.find((c) => c.id === source)?.title ?? '';
      body.append(nameField.wrap, slugField.wrap);
      go.textContent = 'Continue';
      buttons.append(cancel, go);
      queueMicrotask(() => name.focus());
      return;
    }

    if (next === 'source') {
      heading.textContent = source === 'repo' ? 'Pick the repository' : source === 'prd' ? 'Paste the PRD' : 'Describe it';
      subtitle.textContent = options.existing ? options.existing.title : name.value.trim();
      ideaField.label.textContent = source === 'repo' ? 'What do you want done?' : 'What do you want to build?';
      idea.placeholder = source === 'repo'
        ? 'Add a dark mode and tidy the settings page. A paragraph is enough.'
        : 'A terminal timer that logs every session and shows daily focus stats. A paragraph is enough.';
      if (source === 'repo') body.append(repoFields, ideaField.wrap);
      else body.append(source === 'prd' ? prdField.wrap : ideaField.wrap);
      go.textContent = options.existing ? 'Draft the PRD' : 'Create project';
      buttons.append(cancel, go);
      queueMicrotask(() => (source === 'repo' ? (pickerField.wrap.hidden ? repo : picker) : source === 'prd' ? prd : idea).focus());
    }
  };

  back.addEventListener('click', () => {
    if (step === 'source' && !options.existing) show('name');
    else show('choose');
  });

  // ---- the draft being written ---------------------------------------------------------------

  const stream = el('pre', 'stream');
  stream.setAttribute('aria-live', 'polite');
  const streamNote = el('p', 'wizard__note', '');

  const showStream = (): void => {
    step = 'draft';
    back.hidden = true;
    heading.textContent = 'Drafting the PRD';
    modal.box.dataset.step = 'draft';
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
   * owner on a dead sheet, since the Overview can start the draft again.
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

  const submit = (): void => {
    if (step === 'name') {
      const title = name.value.trim();
      if (!title) { say('A name is required.'); name.focus(); return; }
      const wanted = slug.value.trim() || deriveSlug(title);
      const bad = slugProblem(wanted);
      if (bad) { say(bad); slug.focus(); return; }
      show('source');
      return;
    }
    if (step !== 'source') return;

    const box = source === 'prd' ? prd : idea;
    const text = box.value.trim();
    if (source === 'repo') {
      const badRepo = repoProblem(repo.value);
      if (badRepo) { say(badRepo); repo.focus(); return; }
    }
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
    const wanted = slug.value.trim() || deriveSlug(title);
    go.disabled = true;
    go.textContent = source === 'repo' ? 'Cloning…' : 'Creating…';
    say('');
    // The hub clones before it answers, so this call carries the 400/502 a bad repository earns —
    // shown on the same error line as every other reason creation could fail.
    void sendJson('/api/projects', wizardPayload({
      source, slug: wanted, title, text, repo: repo.value, branch: branch.value,
    }))
      .then(() => runDraft(wanted, text))
      .catch((error: unknown) => {
        go.disabled = false;
        go.textContent = 'Create project';
        say(`Could not create the project: ${String(error)}`);
      });
  };

  go.addEventListener('click', submit);
  // Return in a one-line field moves on; Cmd/Ctrl-Return does it from a text area.
  modal.box.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || ((event.metaKey || event.ctrlKey) && target instanceof HTMLTextAreaElement)) {
      event.preventDefault();
      submit();
    }
  });

  show('choose');

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
        repoField.label.textContent = 'or type owner/repo';
      })
      .catch(() => { /* leave the note as the plain sentence */ });
  }

  // A re-draft for a project that already has an intake: prefill it, so a failed first draft
  // doesn't mean re-pasting the owner's idea or PRD — and skip straight to it.
  if (options.existing) {
    const slugValue = options.existing.slug;
    void getJson<{ manifest: ProjectManifest }>(`/api/projects/${slugValue}`)
      .then(({ manifest }) => {
        if (closed || step !== 'choose') return;
        const intake = manifest.intake;
        if (intake?.prd) {
          prd.value = intake.prd;
          source = 'prd';
          show('source');
        } else if (intake?.idea) {
          idea.value = intake.idea;
          source = 'idea';
          show('source');
        }
      })
      .catch(() => { /* no intake to prefill; the blank form still works */ });
  }

  return dispose;
}
