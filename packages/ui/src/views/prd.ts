import { getJson, sendJson } from '../api.js';
import { button, el } from '../dom.js';
import { mountDocShell, splitSections, type DocPage, type DocShellHandle } from '../panels/docshell.js';
import { openProjectWizard } from '../panels/wizard.js';
import { auditStrip, type AuditStrip, type PrdDoc } from '../prd.js';
import { toast } from '../toast.js';
import { chatToAdjust, docBar, note, type ViewContext } from './parts.js';

/**
 * The PRD view: the document, how complete the hub thinks it is, and the two ways to change it —
 * talk to the writer, or edit the markdown by hand.
 *
 * The document is read a section at a time through the docs shell — its `##` headings are the
 * sidebar, which is what the audit grades anyway — and the completeness score rides in the title
 * row. Editing still hands over the whole markdown in one textarea: the sections are a way to
 * read the document, not a way to slice the file.
 */
export function mountPrd(host: HTMLElement, ctx: ViewContext, seeded: string[] = []): () => void {
  let doc: PrdDoc | null = null;
  let state: 'loading' | 'ready' | 'failed' = 'loading';
  let failure = '';
  let editing = false;
  let dismissed = false;
  /** The drafter's open questions, until the document starts reporting its own. */
  let seed = seeded;
  /** Bumped per fetch, so a slow answer for a view we have left is dropped. */
  let token = 0;
  let alive = true;
  /** The section being read, by its heading id; empty means "the first one". */
  let selected = '';
  let shell: DocShellHandle | null = null;

  const load = (): void => {
    const mine = ++token;
    if (!doc) state = 'loading';
    void getJson<PrdDoc>(`/api/projects/${ctx.slug}/prd`)
      .then((next) => {
        if (mine !== token || !alive) return;
        doc = next;
        state = 'ready';
        render();
      })
      .catch((error: unknown) => {
        if (mine !== token || !alive) return;
        state = 'failed';
        failure = `Could not load the PRD: ${String(error)}`;
        render();
      });
  };

  /** The document's `##` sections — the shell's pages, and what the audit grades. */
  const sections = (): DocPage[] => splitSections(doc?.markdown ?? '', 'Overview');

  /**
   * The section chips. Clicking one opens that section in the shell; the score is not here any
   * more — it sits beside the title, where the shell puts a badge.
   */
  const completeness = (strip: AuditStrip): HTMLElement | null => {
    if (!strip.chips.length) return null;
    const row = el('div', 'chips');
    for (const chip of strip.chips) {
      const node = button(chip.heading, chip.className);
      node.title = chip.hint;
      node.addEventListener('click', () => {
        if (!sections().some((section) => section.id === chip.targetId)) {
          toast(`“${chip.heading}” is not in the document yet.`);
          return;
        }
        // Through the shell's own navigation, so a chip lands at the section's top like a rail click.
        if (shell) shell.navigate(chip.targetId);
        else selected = chip.targetId;
      });
      row.appendChild(node);
    }
    return row;
  };

  /** The drafter's open questions, above the document until they are waved away. */
  const callout = (): HTMLElement | null => {
    const questions = doc?.questions?.length ? doc.questions : seed;
    if (dismissed || !questions.length) return null;
    const box = el('aside', 'callout');
    const head = el('div', 'callout__head');
    const close = button('×', 'callout__close');
    close.title = 'Dismiss';
    close.addEventListener('click', () => { dismissed = true; render(); });
    head.append(el('h3', undefined, `${questions.length} open question${questions.length === 1 ? '' : 's'}`), close);
    const list = el('ul');
    for (const question of questions) list.appendChild(el('li', undefined, question));
    box.append(head, list);
    return box;
  };

  const editor = (): HTMLElement => {
    const wrap = el('div', 'editor');
    const area = el('textarea', 'input editor__area');
    area.value = doc?.markdown ?? '';
    area.spellcheck = false;
    const actions = el('div', 'actions');
    const save = el('button', 'btn btn--primary', 'Save');
    save.type = 'button';
    const cancel = button('Cancel');
    cancel.addEventListener('click', () => { editing = false; render(); });
    save.addEventListener('click', () => {
      save.disabled = true;
      save.textContent = 'Saving…';
      void sendJson(`/api/projects/${ctx.slug}/prd`, { markdown: area.value }, 'PUT')
        .then(() => {
          toast('PRD saved.');
          editing = false;
          load();
        })
        .catch((error: unknown) => {
          toast(`Could not save the PRD: ${String(error)}`, 'error');
          save.disabled = false;
          save.textContent = 'Save';
        });
    });
    actions.append(save, cancel);
    wrap.append(area, actions);
    return wrap;
  };

  const draftFlow = (): void => {
    openProjectWizard(document.body, {
      existing: { slug: ctx.slug, title: ctx.title },
      onDone: (_slug, questions) => {
        if (!alive) return;
        seed = questions;
        dismissed = false;
        toast(questions.length
          ? `PRD drafted — ${questions.length} open question${questions.length === 1 ? '' : 's'}`
          : 'PRD drafted.');
        load();
      },
    });
  };

  function render(): void {
    host.replaceChildren();
    const { bar, actions } = docBar(ctx);
    host.appendChild(bar);

    if (state === 'loading') { host.appendChild(note('Loading the PRD…')); return; }

    if (state === 'failed') {
      host.appendChild(note(failure, 'error'));
      const retry = button('Try again');
      retry.addEventListener('click', load);
      actions.appendChild(retry);
      return;
    }

    if (!doc?.drafted) {
      const empty = el('div', 'blank');
      empty.append(
        el('p', 'blank__line', 'No PRD yet — draft one.'),
        el('p', 'blank__hint', 'Describe what you want to build, or paste a document you already have.'),
      );
      const draft = el('button', 'btn btn--primary', 'Draft a PRD');
      draft.type = 'button';
      draft.addEventListener('click', draftFlow);
      empty.appendChild(draft);
      host.appendChild(empty);
      return;
    }

    actions.append(chatToAdjust(ctx, 'prd', load));
    if (!editing) {
      const edit = button('Edit');
      edit.addEventListener('click', () => { editing = true; render(); });
      actions.appendChild(edit);
    }

    if (editing) {
      shell?.destroy();
      shell = null;
      host.appendChild(editor());
      return;
    }

    const audit = auditStrip(doc.audit);
    const strip = completeness(audit);
    if (strip) host.appendChild(strip);
    const questions = callout();
    if (questions) host.appendChild(questions);

    const pages = sections();
    if (!pages.length) {
      // A title-only PRD: the shell from a fuller version must not linger, observers and all.
      shell?.destroy();
      shell = null;
      host.appendChild(note('The PRD is empty.'));
      return;
    }

    const badge = audit.chips.length ? audit.scoreLabel : undefined;
    if (shell) {
      host.appendChild(shell.root);
      shell.update({ pages, current: selected, badge });
      return;
    }
    shell = mountDocShell(host, {
      pages,
      current: selected,
      title: 'PRD',
      badge,
      onNavigate: (id) => { selected = id; shell?.update({ current: id }); },
    });
  }

  render();
  load();

  return () => {
    alive = false;
    token++;
    shell?.destroy();
    shell = null;
    host.replaceChildren();
  };
}
