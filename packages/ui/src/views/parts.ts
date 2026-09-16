import type { ArtifactId } from '../artifacts.js';
import { button, el } from '../dom.js';
import type { ChatTarget } from '../panels/chat.js';

/** What a document view needs from the sheet it lives in. */
export interface ViewContext {
  slug: string;
  title: string;
  /** Opens the chat drawer beside this view, closing whichever one is already open. */
  openChat(target: ChatTarget): void;
  /** Swaps the sheet to another artifact, e.g. an empty roadmap pointing at the PRD. */
  openArtifact(id: ArtifactId): void;
}

/** The three document agents a view can talk to; each is a `who` on the project's chat routes. */
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
 * The toolbar above every document. The sheet's header already names the artifact, so this row is
 * only what can be done to it, held hard right.
 */
export function docBar(): { bar: HTMLElement; actions: HTMLElement } {
  const bar = el('div', 'doc__bar');
  const actions = el('div', 'actions');
  bar.appendChild(actions);
  return { bar, actions };
}

/** A short line where a view would otherwise be blank: loading, empty, or a failed fetch. */
export function note(text: string, kind: 'empty' | 'error' = 'empty'): HTMLElement {
  return el('p', kind === 'error' ? 'empty empty--error' : 'empty', text);
}
