import type { ArtifactId } from '../artifacts.js';
import { button, el } from '../dom.js';
import { icon } from '../icons.js';
import type { ChatTarget } from '../panels/chat.js';

/** What a view needs from the project page it lives in. */
export interface ViewContext {
  slug: string;
  title: string;
  /**
   * Opens the chat pane beside this view, closing whichever one is already open; asking again for
   * the conversation already open closes it, so the button that opened it is also its toggle.
   */
  openChat(target: ChatTarget): void;
  /** Moves the page to another part of the project, e.g. an empty roadmap pointing at the PRD. */
  openArtifact(id: ArtifactId): void;
  /**
   * Shows `path` in Code → Files, opened at `line` — where a map link, a tour step or a citation in
   * the Guide's reply goes. An open Guide pane stays open across the move.
   */
  openCode(path: string, line?: number): void;
  /**
   * Opens the Guide — the code's chat, the same one the toolbar's chat button opens on the Code
   * tab — in the pane, with `draft` already in its box when given (the tour's *Ask about this*).
   */
  openGuide(draft?: string): void;
  /**
   * Where the view's own actions go, when the page gives it a place for them (the bar under the
   * toolbar); absent, they sit in a row at the top of the view.
   */
  actions?: HTMLElement;
}

/** The three document agents a view can talk to; each is a `who` on the project's chat routes. */
export type DocWho = 'prd' | 'roadmap' | 'docs';

const WHO_NAMES: Record<DocWho, string> = {
  prd: 'PRD writer',
  roadmap: 'Roadmap planner',
  docs: 'Docs writer',
};

/** The button's words: who you would be talking to. */
const ASK: Record<DocWho, string> = {
  prd: 'Ask the PRD writer',
  roadmap: 'Ask the planner',
  docs: 'Ask the docs writer',
};

/**
 * "Chat to adjust": the same drawer the org chart opens, pointed at the agent that owns this
 * document. `onReply` re-reads the document after each answer, so an edit the agent just made is
 * on screen by the time it says it made one.
 */
export function chatToAdjust(ctx: ViewContext, who: DocWho, onReply: () => void): HTMLButtonElement {
  const open = button('', 'btn btn--plain btn--small');
  open.append(icon('chat', 15), document.createTextNode(ASK[who]));
  open.title = `Talk it through with the agent that keeps this ${who === 'roadmap' ? 'plan' : 'document'} — it can edit it for you`;
  open.addEventListener('click', () => {
    ctx.openChat({
      name: WHO_NAMES[who],
      subtitle: `${ctx.title} · ${who}`,
      endpoint: `/api/projects/${ctx.slug}/chat/${who}/messages`,
      historyEndpoint: `/api/projects/${ctx.slug}/chat/${who}`,
      onReply,
    });
  });
  return open;
}

/**
 * What can be done to a document, held hard right. Where the page gave the view a place for its
 * actions (`ctx.actions`), they go there and the row in the view stays empty and hidden.
 */
export function docBar(ctx?: ViewContext): { bar: HTMLElement; actions: HTMLElement } {
  const bar = el('div', 'doc__bar');
  const actions = el('div', 'actions');
  if (ctx?.actions) {
    ctx.actions.replaceChildren(actions);
    bar.hidden = true;
    return { bar, actions };
  }
  bar.appendChild(actions);
  return { bar, actions };
}

/** A short line where a view would otherwise be blank: loading, empty, or a failed fetch. */
export function note(text: string, kind: 'empty' | 'error' = 'empty'): HTMLElement {
  return el('p', kind === 'error' ? 'empty empty--error' : 'empty', text);
}
