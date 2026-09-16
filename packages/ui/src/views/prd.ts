import { getJson, sendJson } from '../api.js';
import { button, el } from '../dom.js';
import { renderMarkdown } from '../markdown.js';
import { openProjectWizard } from '../panels/wizard.js';
import { auditStrip, type PrdDoc } from '../prd.js';
import { toast } from '../toast.js';
import { chatToAdjust, docBar, note, type ViewContext } from './parts.js';

/**
 * The PRD view: the document, how complete the hub thinks it is, and the two ways to change it —
 * talk to the writer, or edit the markdown by hand.
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

  /** The section chips, and the score on the right. Clicking one jumps to that heading. */
  const completeness = (body: HTMLElement): HTMLElement | null => {
    const strip = auditStrip(doc?.audit);
    if (!strip.chips.length) return null;
    const row = el('div', 'chips');
    for (const chip of strip.chips) {
      const node = button(chip.heading, chip.className);
      node.title = chip.hint;
      node.addEventListener('click', () => {
        const target = body.querySelector(`[id="${CSS.escape(chip.targetId)}"]`);
        if (target) target.scrollIntoView({ block: 'start' });
        else toast(`“${chip.heading}” is not in the document yet.`);
      });
      row.appendChild(node);
    }
    row.appendChild(el('span', 'chips__score', strip.scoreLabel));
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
    const { bar, actions } = docBar();
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

    if (editing) { host.appendChild(editor()); return; }

    const body = el('article', 'md');
    body.innerHTML = renderMarkdown(doc.markdown ?? '');
    const strip = completeness(body);
    if (strip) host.appendChild(strip);
    const questions = callout();
    if (questions) host.appendChild(questions);
    host.appendChild(body);
  }

  render();
  load();

  return () => {
    alive = false;
    token++;
    host.replaceChildren();
  };
}
