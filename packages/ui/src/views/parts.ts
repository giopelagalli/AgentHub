import { button, el } from '../dom.js';
import { openChat } from '../panels/chat.js';
import type { TabId } from '../tabs.js';

/** What a document tab needs from the page it lives in. */
export interface ViewContext {
  slug: string;
  title: string;
  /** Opens a drawer, closing whichever one is already open. */
  openDrawer(open: (into: HTMLElement) => () => void): void;
  /** Switches the project detail pane to another tab, e.g. an empty state pointing at the PRD. */
  switchTab(tab: TabId): void;
}

/** The three document agents a tab can talk to; each is a `who` on the project's chat routes. */
export type DocWho = 'prd' | 'roadmap' | 'docs';

const WHO_NAMES: Record<DocWho, string> = {
  prd: 'PRD writer',
  roadmap: 'Roadmap planner',
  docs: 'Docs writer',
};

/**
 * "Chat to adjust": the same drawer the org chart opens, pointed at the agent that owns this
 * document. `onReply` re-reads the document after each answer, so an edit the agent just made is
 * on screen by the time it says it made one.
 */
export function chatToAdjust(ctx: ViewContext, who: DocWho, onReply: () => void): HTMLButtonElement {
  const open = button('Chat to adjust');
  open.addEventListener('click', () => {
    ctx.openDrawer((into) => openChat(into, {
      name: WHO_NAMES[who],
      subtitle: `${ctx.title} · ${who}`,
      endpoint: `/api/projects/${ctx.slug}/chat/${who}/messages`,
      historyEndpoint: `/api/projects/${ctx.slug}/chat/${who}`,
      onReply,
    }));
  });
  return open;
}

/** The bar above every document: what it is on the left, what you can do to it on the right. */
export function docBar(label: string): { bar: HTMLElement; actions: HTMLElement } {
  const bar = el('div', 'doc__bar');
  const actions = el('div', 'actions');
  bar.append(el('h2', 'doc__label', label), actions);
  return { bar, actions };
}

/** A short line where a view would otherwise be blank: loading, empty, or a failed fetch. */
export function note(text: string, kind: 'empty' | 'error' = 'empty'): HTMLElement {
  return el('p', kind === 'error' ? 'empty empty--error' : 'empty', text);
}
