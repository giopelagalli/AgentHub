import { parseSseFrames } from '../sse.js';

export interface ChatTarget {
  /** Speaker name in the log and the panel heading. */
  name: string;
  /** SSE route this panel posts `{ text }` to. */
  endpoint: string;
  /**
   * Base route for the confirmation gate (`<base>/<id>/confirm|cancel`). Only the assistant
   * proposes outward actions, so only the assistant passes this.
   */
  pendingBase?: string;
}

interface PendingAction {
  id: string;
  description: string;
}

/**
 * The talk panel: a session-local transcript on the right of the screen.
 * Sending posts to the hub's SSE route and types the reply in as the tokens
 * arrive; closing aborts the request, which the hub reads as a disconnect and
 * frees the stream slot.
 */
export function openChat(host: HTMLElement, target: ChatTarget): () => void {
  const panel = document.createElement('div');
  panel.className = 'gb-panel gb-panel--chat';

  const heading = document.createElement('h2');
  heading.textContent = target.name;
  panel.appendChild(heading);

  const note = document.createElement('p');
  note.className = 'gb-hint';
  note.textContent = 'This log is session-only; history persists server-side.';
  panel.appendChild(note);

  const log = document.createElement('div');
  log.className = 'gb-chat__log';
  panel.appendChild(log);

  const form = document.createElement('form');
  form.className = 'gb-chat__form';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Say something';
  input.autocomplete = 'off';
  const send = document.createElement('button');
  send.type = 'submit';
  send.textContent = 'Send';
  form.append(input, send);
  panel.appendChild(form);

  const hint = document.createElement('p');
  hint.className = 'gb-hint';
  hint.textContent = 'Esc to close';
  panel.appendChild(hint);

  /** Within a few pixels of the end, so a reader who scrolled back stays there. */
  const atBottom = (): boolean => log.scrollHeight - log.scrollTop - log.clientHeight < 8;
  const pinIfFollowing = (wasFollowing: boolean): void => {
    if (wasFollowing) log.scrollTop = log.scrollHeight;
  };

  /** Returns the element the caller keeps writing text into. */
  const addMessage = (speaker: string, text: string, forcePin = false): HTMLElement => {
    const following = forcePin || atBottom();
    const message = document.createElement('p');
    message.className = 'gb-chat__msg';
    const who = document.createElement('span');
    who.className = 'gb-chat__who';
    who.textContent = `${speaker}:`;
    const said = document.createElement('span');
    said.textContent = text;
    message.append(who, said);
    log.appendChild(message);
    pinIfFollowing(following);
    return said;
  };

  /**
   * One row per outward action the reply proposed: nothing has happened yet, and the hub only runs
   * it once Confirm is pressed. Both buttons go away as soon as either is used, so one proposal
   * can't be answered twice.
   */
  const addPending = (actions: PendingAction[]): void => {
    if (!target.pendingBase) return;
    for (const action of actions) {
      const row = document.createElement('p');
      row.className = 'gb-chat__pending';
      const label = document.createElement('span');
      label.textContent = action.description;
      row.appendChild(label);

      const answer = async (verb: 'confirm' | 'cancel'): Promise<void> => {
        row.querySelectorAll('button').forEach((b) => b.remove());
        try {
          const response = await fetch(`${target.pendingBase}/${action.id}/${verb}`, { method: 'POST' });
          if (!response.ok) throw new Error(`hub replied ${response.status}`);
          const body = (await response.json()) as { result?: string };
          label.textContent = verb === 'confirm' ? (body.result ?? 'Done.') : `Cancelled: ${action.description}`;
        } catch (error) {
          label.textContent = `${action.description} — failed: ${String(error)}`;
          row.classList.add('gb-chat__msg--error');
        }
      };

      for (const verb of ['confirm', 'cancel'] as const) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = verb === 'confirm' ? 'Confirm' : 'Cancel';
        button.addEventListener('click', () => void answer(verb));
        row.appendChild(button);
      }
      log.appendChild(row);
      log.scrollTop = log.scrollHeight;
    }
  };

  let inFlight: AbortController | null = null;

  const stream = async (text: string): Promise<void> => {
    // The user's own message always pins to bottom, even if they'd scrolled
    // back to read history — sending is a clear signal they're back at the end.
    addMessage('You', text, true);
    const reply = addMessage(target.name, '');
    const controller = new AbortController();
    inFlight = controller;
    // Captured before disabling blurs the input, so we know whether to give
    // focus back afterwards or leave it wherever the reader had moved to.
    const wasOurs = document.activeElement === input;
    input.disabled = true;
    send.disabled = true;

    // Keep whatever already streamed in: a mid-stream failure is more legible
    // next to the partial reply than in place of it.
    const fail = (message: string): void => {
      reply.textContent = reply.textContent ? `${reply.textContent}\n${message}` : message;
      reply.parentElement?.classList.add('gb-chat__msg--error');
    };

    try {
      const response = await fetch(target.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`hub replied ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let rest = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const parsed = parseSseFrames(rest + decoder.decode(value, { stream: true }));
        rest = parsed.rest;
        for (const event of parsed.events) {
          const following = atBottom();
          if (event.token !== undefined) reply.textContent += event.token;
          if (event.error !== undefined) fail(event.error);
          // The done frame carries the whole reply: trust it over the pieces.
          if (event.done && typeof event.full === 'string') reply.textContent = event.full;
          pinIfFollowing(following);
          if (event.done && event.pending?.length) addPending(event.pending);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) fail(String(error));
    } finally {
      inFlight = null;
      if (panel.isConnected) {
        input.disabled = false;
        send.disabled = false;
        // Don't steal focus back if the reader clicked into something else.
        if (wasOurs) input.focus();
      }
    }
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || inFlight) return;
    input.value = '';
    void stream(text);
  });

  host.appendChild(panel);
  input.focus();

  return () => {
    inFlight?.abort();
    panel.remove();
  };
}
