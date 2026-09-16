import type { ChatMessage, TeamMemberView } from '@agenthub/shared';
import { getJson } from '../api.js';
import { latestWorkMessages, statusLabel } from '../activity.js';
import { parseSseFrames } from '../sse.js';

/**
 * "What they're doing", shown above the log: an employee's roster status plus their latest work
 * session, or the manager's latest published briefing. `member` comes from the roster the caller
 * already has loaded, so opening the drawer needs no extra roster fetch for the status line.
 */
export type ChatActivity =
  | { kind: 'employee'; member: TeamMemberView; activityUrl: string }
  | { kind: 'manager'; briefingUrl: string };

export interface ChatTarget {
  /** Speaker name in the log and the drawer heading. */
  name: string;
  /** Line under the heading — who this agent is. */
  subtitle?: string;
  /** SSE route this drawer posts `{ text }` to. */
  endpoint: string;
  /** Route the stored history is read from (`{ messages }`); omitted where there is none to read. */
  historyEndpoint?: string;
  /**
   * Base route for the confirmation gate (`<base>/<id>/confirm|cancel`). Only the assistant
   * proposes outward actions, so only the assistant passes this.
   */
  pendingBase?: string;
  /** The "What they're doing" section; omitted for the assistant, which isn't on any roster. */
  activity?: ChatActivity;
  /**
   * Called once a reply has finished streaming. The document tabs use it to re-read the PRD,
   * roadmap or docs the agent has just edited; an aborted send (the drawer closed) doesn't fire.
   */
  onReply?: () => void;
}

interface PendingAction {
  id: string;
  description: string;
}

/** The header every drawer wears: a title, a subtitle, and the close button. */
export function drawerHeader(title: string, subtitle: string | undefined, close: () => void): HTMLElement {
  const header = document.createElement('header');
  header.className = 'drawer__head';

  const text = document.createElement('div');
  const heading = document.createElement('h2');
  heading.textContent = title;
  text.appendChild(heading);
  if (subtitle) {
    const line = document.createElement('p');
    line.className = 'drawer__sub';
    line.textContent = subtitle;
    text.appendChild(line);
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'drawer__close';
  button.textContent = '×';
  button.title = 'Close (Esc)';
  button.addEventListener('click', close);

  header.append(text, button);
  return header;
}

/**
 * The one-on-one chat drawer, on the right of the page. Sending posts to the
 * hub's SSE route and types the reply in as the tokens arrive; closing aborts
 * the request, which the hub reads as a disconnect and frees the stream slot.
 */
export function openChat(host: HTMLElement, target: ChatTarget): () => void {
  const panel = document.createElement('aside');
  panel.className = 'drawer';

  const activityBox = document.createElement('section');
  activityBox.className = 'chat__activity';

  const log = document.createElement('div');
  log.className = 'chat__log';

  const form = document.createElement('form');
  form.className = 'chat__form';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = `Message ${target.name}`;
  input.autocomplete = 'off';
  const send = document.createElement('button');
  send.type = 'submit';
  send.textContent = 'Send';
  form.append(input, send);

  const head = drawerHeader(target.name, target.subtitle, () => dispose());
  panel.append(...(target.activity ? [head, activityBox, log, form] : [head, log, form]));

  /** Within a few pixels of the end, so a reader who scrolled back stays there. */
  const atBottom = (): boolean => log.scrollHeight - log.scrollTop - log.clientHeight < 8;
  const pinIfFollowing = (wasFollowing: boolean): void => {
    if (wasFollowing) log.scrollTop = log.scrollHeight;
  };

  /** Returns the element the caller keeps writing text into. */
  const addMessage = (speaker: string, text: string, forcePin = false): HTMLElement => {
    const following = forcePin || atBottom();
    const message = document.createElement('p');
    message.className = speaker === 'You' ? 'chat__msg chat__msg--own' : 'chat__msg';
    const who = document.createElement('span');
    who.className = 'chat__who';
    who.textContent = speaker;
    const said = document.createElement('span');
    said.className = 'chat__said';
    said.textContent = text;
    message.append(who, said);
    log.appendChild(message);
    pinIfFollowing(following);
    return said;
  };

  const note = (text: string): void => {
    const line = document.createElement('p');
    line.className = 'chat__note';
    line.textContent = text;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
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
      row.className = 'chat__pending';
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
          row.classList.add('chat__msg--error');
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

  /**
   * The stored conversation, oldest first. Only the two roles a reader is part of are
   * shown: the system framing and the agent's tool traffic are not this window's business.
   */
  const loadHistory = async (): Promise<void> => {
    if (!target.historyEndpoint) {
      note('This log is session-only; history persists server-side.');
      return;
    }
    try {
      const { messages } = await getJson<{ messages: ChatMessage[] }>(target.historyEndpoint);
      const said = messages.filter(
        (m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim(),
      );
      if (!said.length) {
        note('No history yet — say hello.');
        return;
      }
      for (const message of said) {
        addMessage(message.role === 'user' ? 'You' : target.name, String(message.content).trim(), true);
      }
    } catch (error) {
      note(`Could not load history: ${String(error)}`);
    }
  };

  /** One line of the "What they're doing" section, built the same way a chat message row is. */
  const activityLine = (className: string, text: string): HTMLElement => {
    const line = document.createElement('p');
    line.className = className;
    line.textContent = text;
    return line;
  };

  /**
   * "What they're doing": an employee's roster status and latest-session excerpt (already in hand
   * from the roster the caller loaded) plus a fetch for the last turns of their current work session;
   * the manager's latest published briefing instead. Best-effort — a failed fetch leaves whatever
   * already rendered from the roster alone rather than replacing it with an error.
   */
  const loadActivity = async (): Promise<void> => {
    const activity = target.activity;
    if (!activity) return;

    if (activity.kind === 'manager') {
      const line = activityLine('chat__activity-line', 'Loading the latest briefing…');
      activityBox.appendChild(line);
      try {
        const { briefing } = await getJson<{ briefing: { summary: string } | null }>(activity.briefingUrl);
        line.textContent = briefing ? briefing.summary : 'No briefing published yet.';
      } catch (error) {
        line.textContent = `Could not load the briefing: ${String(error)}`;
      }
      return;
    }

    const { member, activityUrl } = activity;
    const status = activityLine('chat__activity-line', '');
    const dot = document.createElement('span');
    dot.className = `dot dot--${member.status}`;
    const label = document.createElement('span');
    label.textContent = `${statusLabel(member.status)} · ${member.sessionsCount} session${member.sessionsCount === 1 ? '' : 's'}`;
    status.append(dot, label);
    activityBox.appendChild(status);
    if (member.currentSession?.lastMessage) {
      activityBox.appendChild(activityLine('chat__activity-line chat__activity-excerpt', member.currentSession.lastMessage));
    }

    try {
      const data = await getJson<{ session: unknown; messages: ChatMessage[] }>(activityUrl);
      const lines = data.session ? latestWorkMessages(data.messages, target.name) : [];
      if (!lines.length) return;
      const details = document.createElement('details');
      details.className = 'chat__activity-details';
      const summary = document.createElement('summary');
      summary.textContent = 'Latest work';
      details.appendChild(summary);
      for (const line of lines) {
        const row = document.createElement('p');
        row.className = 'chat__msg';
        const who = document.createElement('span');
        who.className = 'chat__who';
        who.textContent = line.speaker;
        const said = document.createElement('span');
        said.className = 'chat__said';
        said.textContent = line.text;
        row.append(who, said);
        details.appendChild(row);
      }
      activityBox.appendChild(details);
    } catch {
      // The status line above already came from the roster; the "Latest work" block just stays off.
    }
  };

  // The hub answers one project/assistant chat's messages in order, so a second send while the
  // first is still streaming is not blocked — it's queued behind it, same as the hub does server
  // side. Every in-flight controller lives here so a drawer close can abort all of them at once.
  const pending = new Set<AbortController>();

  const stream = async (text: string, queued: boolean): Promise<void> => {
    // The user's own message always pins to bottom, even if they'd scrolled
    // back to read history — sending is a clear signal they're back at the end.
    addMessage('You', text, true);
    const reply = addMessage(target.name, queued ? 'queued…' : '');
    reply.parentElement?.classList.add('chat__msg--typing');
    const controller = new AbortController();
    pending.add(controller);
    // Captured now, so a reader who clicked elsewhere while this was queued doesn't get focus stolen.
    const wasOurs = document.activeElement === input;
    // Set once real content (a token, an error, or the done frame) has replaced the "queued…"
    // placeholder — a message that queued behind another has nothing to show until then.
    let started = !queued;

    // Keep whatever already streamed in: a mid-stream failure is more legible
    // next to the partial reply than in place of it.
    const fail = (message: string): void => {
      if (!started) { reply.textContent = ''; started = true; }
      reply.textContent = reply.textContent ? `${reply.textContent}\n${message}` : message;
      reply.parentElement?.classList.add('chat__msg--error');
    };

    try {
      const response = await fetch(target.endpoint, {
        method: 'POST',
        credentials: 'same-origin',
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
          if (event.token !== undefined) {
            if (!started) { reply.textContent = ''; started = true; }
            reply.textContent += event.token;
          }
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
      pending.delete(controller);
      reply.parentElement?.classList.remove('chat__msg--typing');
      if (!controller.signal.aborted) target.onReply?.();
      // Don't steal focus back if the reader clicked into something else.
      if (panel.isConnected && pending.size === 0 && wasOurs) input.focus();
    }
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    void stream(text, pending.size > 0);
  });

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') dispose();
  };
  window.addEventListener('keydown', onKey);

  host.appendChild(panel);
  void loadActivity();
  void loadHistory();
  input.focus();

  function dispose(): void {
    window.removeEventListener('keydown', onKey);
    for (const controller of pending) controller.abort();
    panel.remove();
  }

  return dispose;
}
