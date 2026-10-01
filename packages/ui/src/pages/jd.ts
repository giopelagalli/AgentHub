import type { JdMessage, JdStatus, JdStreamFrame } from '@agenthub/shared';
import { getJson, sendBytes, sendJson } from '../api.js';
import { button, el } from '../dom.js';
import { icon } from '../icons.js';
import {
  backoffMs, clock, mergeMessages, needsStamp, pickRecordingType, renderJdText, sameRun, stampLabel, uploadType,
} from '../jd.js';
import type { Store } from '../store.js';
import { toast } from '../toast.js';
import { toolbar } from '../toolbar.js';

/**
 * The JD page (FR-C4): the owner's conversation with JD, their assistant, through the hub's door
 * (`/api/jd/*`, decision 0069). A calm column like Messages — the owner's bubbles right, JD's left
 * — with JD's inline keyboards as pills under its bubble, quick keys over the composer, voice notes
 * both ways, and a typing indicator off the stream. Decision 0071 has the choices.
 *
 * Not configured, it says how to connect JD and nothing else; configured but silent, it says so and
 * offers to try again.
 */

/** What the page needs from outside, swappable in a test. */
export interface JdPageDeps {
  /** Opens the stream; null keeps the page off the stream entirely. */
  openStream?: ((url: string) => WebSocket) | null;
}

/** The newest this many messages are loaded on open. */
const HISTORY = 50;
/** A recording stops (and goes) on its own at this length. */
const MAX_RECORDING_MS = 5 * 60 * 1000;
/** Typing that never said it stopped is taken as stopped after this long. */
const TYPING_TIMEOUT_MS = 60_000;
/** Closer to the bottom than this counts as reading the newest message. */
const PINNED_PX = 64;

interface Pending {
  key: string;
  kind: 'text' | 'voice';
  text: string;
  blob?: Blob;
  type?: string;
  failed?: string;
}

const streamUrl = (): string =>
  `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/api/jd/stream`;

export function mountJd(host: HTMLElement, store: Store, deps: JdPageDeps = {}): () => void {
  const openStream = deps.openStream === undefined ? (url: string) => new WebSocket(url) : deps.openStream;
  let name = store.getState().jdName ?? 'JD';
  let alive = true;
  const cleanups: (() => void)[] = [];

  const view = el('div', 'view jd');
  const bar = toolbar();
  const who = el('div', 'jd__who');
  const avatar = el('span', 'jd__avatar');
  avatar.setAttribute('aria-hidden', 'true');
  const names = el('div', 'jd__names');
  const title = el('h1', 'toolbar__title jd__name');
  const sub = el('div', 'jd__sub');
  sub.setAttribute('role', 'status');
  names.append(title, sub);
  who.append(avatar, names);
  bar.leading.appendChild(who);
  const body = el('div', 'view__body view__body--fill jd__body');
  view.append(bar.root, body);
  host.appendChild(view);

  const setName = (next: string): void => {
    name = next;
    title.textContent = name;
    avatar.textContent = name.trim().charAt(0).toUpperCase() || 'J';
  };
  setName(name);

  /** One message centred in the body: what to do when there is no conversation to show. */
  const notice = (heading: string, lines: (string | HTMLElement)[], action?: { label: string; run: () => void }): void => {
    sub.textContent = '';
    const box = el('div', 'jd__notice');
    const badge = el('div', 'jd__noticeicon');
    badge.appendChild(icon('chat', 22));
    box.append(badge, el('h2', 'jd__noticehead', heading));
    for (const line of lines) box.appendChild(typeof line === 'string' ? el('p', 'jd__noticeline', line) : line);
    if (action) {
      const go = button(action.label, 'btn btn--primary');
      go.addEventListener('click', action.run);
      box.appendChild(go);
    }
    body.replaceChildren(box);
  };

  const showSetup = (): void => {
    const code = el('pre', 'jd__envlines');
    code.textContent = 'JD_URL=http://127.0.0.1:8891\nJD_WEB_TOKEN=…';
    const how = el('p', 'jd__noticeline jd__noticeline--small');
    how.append(
      'The token is the same value as ', el('code', '', 'JD_WEB_TOKEN'), ' in JD’s own ', el('code', '', '.env'),
      ' — make it once on the Spark with ', el('code', '', 'openssl rand -hex 32'), '. Help → Talking to JD has the steps.',
    );
    notice('Connect JD', ['Add two lines to the hub’s .env, then restart the hub and JD:', code, how]);
  };

  const showUnreachable = (): void => {
    notice(`${name} isn’t answering`, ['The hub is set up for JD but can’t reach it. Check that JD is running.'], {
      label: 'Try again', run: () => { body.replaceChildren(); void start(); },
    });
  };

  const start = async (): Promise<void> => {
    sub.textContent = 'Connecting…';
    let status: JdStatus;
    try {
      status = await getJson<JdStatus>('/api/jd/status');
    } catch {
      status = { configured: true, reachable: false };
    }
    if (!alive) return;
    if (status.name) {
      setName(status.name);
      store.dispatch({ type: 'jd-name', name: status.name });
    }
    if (!status.configured) showSetup();
    else if (!status.reachable) showUnreachable();
    else chat();
  };

  // --- the conversation ---------------------------------------------------------------------------

  const chat = (): void => {
    let messages: JdMessage[] = [];
    const pending: Pending[] = [];
    let pendingSeq = 0;
    let typing = false;
    let awaiting = 0;
    let loaded = false;
    let typingTimer: ReturnType<typeof setTimeout> | undefined;
    const nodes = new Map<string, { sig: string; node: HTMLElement }>();
    const players = new Set<HTMLAudioElement>();

    const scroller = el('div', 'jd__scroll');
    const log = el('div', 'jd__log');
    log.setAttribute('role', 'log');
    log.setAttribute('aria-label', `Conversation with ${name}`);
    scroller.appendChild(log);

    const jump = button('', 'jd__jump');
    jump.setAttribute('aria-label', 'Jump to the newest message');
    jump.title = 'Newest';
    jump.append(icon('arrowDown', 16));
    jump.hidden = true;

    const dock = el('div', 'jd__dock');
    const dockIn = el('div', 'jd__dockin');
    const keys = el('div', 'jd__keys');
    keys.setAttribute('role', 'toolbar');
    keys.setAttribute('aria-label', 'Quick keys');
    keys.hidden = true;
    const form = el('form', 'jd__composer');
    const input = el('textarea', 'jd__input');
    input.rows = 1;
    input.placeholder = `Message ${name}`;
    input.setAttribute('aria-label', `Message ${name}`);
    input.setAttribute('enterkeyhint', 'send');
    const action = button('', 'jd__action');

    const rec = el('div', 'jd__rec');
    rec.hidden = true;
    const recCancel = button('', 'jd__reccancel');
    recCancel.append(icon('close', 16));
    recCancel.setAttribute('aria-label', 'Discard the recording');
    recCancel.title = 'Discard';
    const recDot = el('span', 'jd__recdot');
    const recClock = el('span', 'jd__recclock num', '0:00');
    const recLabel = el('span', 'jd__reclabel', 'Recording');
    const recSend = button('', 'jd__action jd__action--send');
    recSend.append(icon('arrowUp', 18));
    recSend.setAttribute('aria-label', 'Send the voice note');
    recSend.title = 'Send';
    rec.append(recCancel, recDot, recClock, recLabel, recSend);

    form.append(input, action, rec);
    dockIn.append(keys, form);
    dock.append(jump, dockIn);
    body.replaceChildren(scroller, dock);

    const distance = (): number => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    const toBottom = (smooth = false): void => {
      if (smooth && typeof scroller.scrollTo === 'function') scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
      else scroller.scrollTop = scroller.scrollHeight;
      jump.hidden = true;
    };
    scroller.addEventListener('scroll', () => { if (distance() < PINNED_PX) jump.hidden = true; });
    jump.addEventListener('click', () => toBottom(true));

    // -- rendering

    const player = (audio: NonNullable<JdMessage['audio']>): HTMLElement => {
      const box = el('div', 'jd__voice');
      const play = button('', 'jd__play');
      const track = el('div', 'jd__track');
      const fill = el('div', 'jd__trackfill');
      track.appendChild(fill);
      const time = el('span', 'jd__voicetime num', 'Voice');
      const media = new Audio();
      media.preload = 'none';
      media.src = `/api/jd/audio/${encodeURIComponent(audio.id)}`;
      players.add(media);
      const face = (playing: boolean): void => {
        play.replaceChildren(icon(playing ? 'pause' : 'play', 14));
        play.setAttribute('aria-label', playing ? 'Pause the voice note' : 'Play the voice note');
      };
      face(false);
      const known = (): boolean => Number.isFinite(media.duration) && media.duration > 0;
      play.addEventListener('click', () => {
        if (!media.paused) { media.pause(); return; }
        for (const other of players) if (other !== media) other.pause();
        // Called in the tap itself, which is what lets Safari on a phone start the sound.
        void media.play().catch(() => toast('That voice note wouldn’t play.', 'error'));
      });
      track.addEventListener('click', (event) => {
        if (!known()) return;
        const box = track.getBoundingClientRect();
        media.currentTime = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * media.duration;
      });
      media.addEventListener('play', () => face(true));
      media.addEventListener('pause', () => face(false));
      media.addEventListener('loadedmetadata', () => { if (known()) time.textContent = clock(media.duration); });
      media.addEventListener('timeupdate', () => {
        if (!known()) return;
        fill.style.width = `${(media.currentTime / media.duration) * 100}%`;
        time.textContent = clock(media.paused ? media.duration : media.currentTime);
      });
      media.addEventListener('ended', () => {
        fill.style.width = '0%';
        if (known()) time.textContent = clock(media.duration);
      });
      box.append(play, track, time);
      return box;
    };

    const keyboard = (message: JdMessage): HTMLElement => {
      const box = el('div', 'jd__buttons');
      const all: HTMLButtonElement[] = [];
      for (const row of message.buttons ?? []) {
        const line = el('div', 'jd__btnrow');
        for (const choice of row) {
          const pill = button(choice.label, 'jd__btn');
          all.push(pill);
          pill.addEventListener('click', () => {
            for (const b of all) b.disabled = true;
            pill.setAttribute('aria-busy', 'true');
            sendJson<{ messages: JdMessage[] }>('/api/jd/callback', { data: choice.data })
              .then((answer) => {
                if (!alive) return;
                messages = mergeMessages(messages, answer?.messages ?? []);
                // No edit came back: the keyboard stays, usable again.
                for (const b of all) b.disabled = false;
                pill.removeAttribute('aria-busy');
                render();
              })
              .catch((err: Error) => {
                for (const b of all) b.disabled = false;
                pill.removeAttribute('aria-busy');
                toast(err.message, 'error');
              });
          });
          line.appendChild(pill);
        }
        box.appendChild(line);
      }
      return box;
    };

    const messageNode = (message: JdMessage): HTMLElement => {
      const sig = JSON.stringify(message);
      const known = nodes.get(message.id);
      if (known?.sig === sig) return known.node;
      const row = el('div', `jd__msg jd__msg--${message.from === 'owner' ? 'owner' : 'jd'}`);
      const bubble = el('div', 'jd__bubble');
      bubble.title = new Date(message.at).toLocaleString();
      if (message.audio) bubble.appendChild(player(message.audio));
      if (message.text) {
        const text = el('div', 'jd__text');
        text.appendChild(renderJdText(message));
        bubble.appendChild(text);
      }
      row.appendChild(bubble);
      if (message.from === 'jd' && message.buttons?.length) row.appendChild(keyboard(message));
      nodes.set(message.id, { sig, node: row });
      return row;
    };

    const stampNode = (message: JdMessage): HTMLElement => {
      const key = `stamp:${message.id}`;
      const node = nodes.get(key)?.node ?? el('div', 'jd__stamp');
      node.textContent = stampLabel(message.at);
      nodes.set(key, { sig: '', node });
      return node;
    };

    const pendingNode = (item: Pending): HTMLElement => {
      const key = `pending:${item.key}:${item.failed ? 'failed' : 'sending'}`;
      const cached = nodes.get(key);
      if (cached) return cached.node;
      const row = el('div', `jd__msg jd__msg--owner ${item.failed ? 'jd__msg--failed' : 'jd__msg--pending'}`);
      const bubble = el('div', 'jd__bubble');
      if (item.kind === 'voice') {
        const note = el('div', 'jd__voice jd__voice--own');
        note.append(icon('mic', 16), el('span', '', item.failed ? 'Voice note' : 'Sending voice note…'));
        bubble.appendChild(note);
      } else {
        bubble.appendChild(el('div', 'jd__text', item.text));
      }
      row.appendChild(bubble);
      if (item.failed) {
        const line = el('div', 'jd__failed');
        const retry = button('Retry', 'jd__retry');
        retry.addEventListener('click', () => {
          pending.splice(pending.indexOf(item), 1);
          if (item.kind === 'voice' && item.blob) void sendVoice(item.blob, item.type ?? 'audio/webm');
          else void sendText(item.text);
        });
        line.append(`Not delivered — ${item.failed}. `, retry);
        row.appendChild(line);
      }
      nodes.set(key, { sig: '', node: row });
      return row;
    };

    const typingNode = el('div', 'jd__msg jd__msg--jd jd__typing');
    const dots = el('div', 'jd__bubble');
    dots.setAttribute('aria-label', `${name} is typing`);
    dots.append(el('span', 'jd__dot'), el('span', 'jd__dot'), el('span', 'jd__dot'));
    typingNode.appendChild(dots);

    const hello = el('div', 'jd__hello');

    const render = (): void => {
      const pinned = distance() < PINNED_PX;
      const before = log.lastElementChild;
      const desired: HTMLElement[] = [];
      messages.forEach((message, i) => {
        const previous = messages[i - 1];
        const next = messages[i + 1];
        const stamped = needsStamp(previous, message);
        if (stamped) desired.push(stampNode(message));
        const node = messageNode(message);
        node.classList.toggle('jd__msg--joinprev', !stamped && sameRun(previous, message));
        node.classList.toggle('jd__msg--joinnext', !!next && !needsStamp(message, next) && sameRun(message, next));
        desired.push(node);
      });
      for (const item of pending) desired.push(pendingNode(item));
      if (typing || awaiting > 0) desired.push(typingNode);
      if (loaded && !messages.length && !pending.length) {
        hello.textContent = `Say hello to ${name}${keys.hidden ? '.' : ' — or tap a quick key below.'}`;
        desired.push(hello);
      }
      // Keyed: a node already in place stays put, so a voice note playing in it keeps playing.
      desired.forEach((node, i) => {
        if (log.children[i] !== node) log.insertBefore(node, log.children[i] ?? null);
      });
      while (log.children.length > desired.length) log.lastElementChild!.remove();
      const live = new Set(desired);
      for (const [key, entry] of nodes) if (!live.has(entry.node)) nodes.delete(key);

      if (pinned) toBottom();
      else if (log.lastElementChild !== before) jump.hidden = false;
    };

    const setTyping = (on: boolean): void => {
      typing = on;
      clearTimeout(typingTimer);
      if (on) typingTimer = setTimeout(() => { typing = false; render(); }, TYPING_TIMEOUT_MS);
      render();
    };

    // -- sending

    const settle = (item: Pending, sent: JdMessage[]): void => {
      pending.splice(pending.indexOf(item), 1);
      messages = mergeMessages(messages, sent);
    };

    const sendText = async (raw: string): Promise<void> => {
      const text = raw.trim();
      if (!text) return;
      const item: Pending = { key: String(++pendingSeq), kind: 'text', text };
      pending.push(item);
      awaiting++;
      render();
      toBottom();
      try {
        const answer = await sendJson<{ messages: JdMessage[] }>('/api/jd/messages', { text });
        settle(item, answer?.messages ?? []);
      } catch (err) {
        item.failed = (err as Error).message;
      } finally {
        awaiting--;
        if (alive) render();
      }
    };

    const sendVoice = async (blob: Blob, type: string): Promise<void> => {
      const item: Pending = { key: String(++pendingSeq), kind: 'voice', text: '', blob, type };
      pending.push(item);
      awaiting++;
      render();
      toBottom();
      try {
        const answer = await sendBytes<{ transcript?: string; messages: JdMessage[] }>('/api/jd/voice', blob, type);
        const sent = answer.messages ?? [];
        // JD echoes what it heard as the owner's message; if it didn't, the transcript stands in.
        if (!sent.some((m) => m.from === 'owner') && answer.transcript) {
          sent.unshift({ id: `local-voice-${item.key}`, from: 'owner', at: Date.now(), text: answer.transcript, format: 'plain' });
        }
        settle(item, sent);
      } catch (err) {
        item.failed = (err as Error).message;
      } finally {
        awaiting--;
        if (alive) render();
      }
    };

    // -- the composer

    const fit = (): void => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
    };
    const face = (): void => {
      const hasText = input.value.trim().length > 0;
      action.classList.toggle('jd__action--send', hasText);
      action.replaceChildren(icon(hasText ? 'arrowUp' : 'mic', 18));
      action.setAttribute('aria-label', hasText ? 'Send' : 'Record a voice note');
      action.title = hasText ? 'Send' : 'Record a voice note';
    };
    face();
    const submit = (): void => {
      const text = input.value;
      if (!text.trim()) return;
      input.value = '';
      fit();
      face();
      void sendText(text);
    };
    input.addEventListener('input', () => { fit(); face(); });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        submit();
      }
    });
    form.addEventListener('submit', (event) => { event.preventDefault(); submit(); });
    action.addEventListener('click', () => {
      if (input.value.trim()) submit();
      else void record();
    });

    // -- voice notes: tap the mic to start, then send or discard (decision 0071)

    let recording: { recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; type: string; ticker: ReturnType<typeof setInterval>; startedAt: number } | null = null;

    const record = async (): Promise<void> => {
      if (recording) return;
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        toast(window.isSecureContext === false
          ? 'Voice notes need the hub over HTTPS.'
          : 'This browser can’t record audio.', 'error');
        return;
      }
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        toast('The microphone wasn’t allowed.', 'error');
        return;
      }
      if (!alive) { for (const track of stream.getTracks()) track.stop(); return; }
      const type = pickRecordingType((t) => MediaRecorder.isTypeSupported(t));
      const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      const chunks: Blob[] = [];
      recorder.addEventListener('dataavailable', (event) => { if (event.data.size) chunks.push(event.data); });
      const startedAt = Date.now();
      const ticker = setInterval(() => {
        const ms = Date.now() - startedAt;
        recClock.textContent = clock(ms / 1000);
        if (ms >= MAX_RECORDING_MS) finish(true);
      }, 250);
      recording = { recorder, stream, chunks, type, ticker, startedAt };
      recorder.start();
      recClock.textContent = '0:00';
      form.classList.add('jd__composer--rec');
      rec.hidden = false;
      recSend.focus();
    };

    const finish = (send: boolean): void => {
      const current = recording;
      if (!current) return;
      recording = null;
      clearInterval(current.ticker);
      form.classList.remove('jd__composer--rec');
      rec.hidden = true;
      current.recorder.addEventListener('stop', () => {
        for (const track of current.stream.getTracks()) track.stop();
        if (!send || !alive) return;
        const type = uploadType(current.recorder.mimeType || current.type);
        const blob = new Blob(current.chunks, { type });
        if (blob.size) void sendVoice(blob, type);
      }, { once: true });
      if (current.recorder.state !== 'inactive') current.recorder.stop();
      input.focus({ preventScroll: true });
    };
    recSend.addEventListener('click', () => finish(true));
    recCancel.addEventListener('click', () => finish(false));
    rec.addEventListener('keydown', (event) => { if (event.key === 'Escape') finish(false); });
    cleanups.push(() => {
      if (recording) {
        clearInterval(recording.ticker);
        for (const track of recording.stream.getTracks()) track.stop();
        recording = null;
      }
      for (const media of players) media.pause();
      clearTimeout(typingTimer);
    });

    // -- loading, and the stream

    const loadHistory = async (): Promise<void> => {
      const answer = await getJson<{ messages: JdMessage[] }>(`/api/jd/history?limit=${HISTORY}`);
      if (!alive) return;
      messages = mergeMessages(messages, answer.messages ?? []);
      loaded = true;
      render();
      toBottom();
    };
    void loadHistory().catch((err: Error) => {
      loaded = true;
      render();
      toast(`Couldn’t load the conversation: ${err.message}`, 'error');
    });
    void getJson<{ keys: string[] }>('/api/jd/keys').then((answer) => {
      if (!alive) return;
      const list = (answer.keys ?? []).filter((k) => typeof k === 'string' && k.trim());
      keys.replaceChildren(...list.map((key) => {
        const chip = button(key, 'jd__key');
        chip.addEventListener('click', () => { void sendText(key); });
        return chip;
      }));
      keys.hidden = list.length === 0;
      render();
    }).catch(() => { /* no keys is a page without the row */ });

    if (openStream) {
      let socket: WebSocket | null = null;
      let attempt = 0;
      let everOpen = false;
      let retry: ReturnType<typeof setTimeout> | undefined;
      const connect = (): void => {
        if (!alive) return;
        clearTimeout(retry);
        const next = openStream(streamUrl());
        socket = next;
        next.addEventListener('open', () => {
          attempt = 0;
          sub.textContent = 'Online';
          // Back after a gap: whatever JD said meanwhile is in its history.
          if (everOpen) void loadHistory().catch(() => {});
          everOpen = true;
        });
        next.addEventListener('message', (event) => {
          let frame: JdStreamFrame;
          try { frame = JSON.parse(String(event.data)) as JdStreamFrame; } catch { return; }
          if (frame.type === 'typing') setTyping(frame.on);
          else if (frame.type === 'message' && frame.message) {
            messages = mergeMessages(messages, [frame.message]);
            if (frame.message.from === 'jd') setTyping(false);
            else render();
          }
        });
        next.addEventListener('close', () => {
          if (!alive || socket !== next) return;
          socket = null;
          sub.textContent = 'Reconnecting…';
          if (typing) setTyping(false);
          retry = setTimeout(connect, backoffMs(attempt++));
        });
      };
      // A phone puts the tab to sleep and its socket with it; coming back reconnects at once.
      const onVisible = (): void => {
        if (document.visibilityState === 'visible' && !socket) { attempt = 0; connect(); }
      };
      document.addEventListener('visibilitychange', onVisible);
      cleanups.push(() => {
        document.removeEventListener('visibilitychange', onVisible);
        clearTimeout(retry);
        const open = socket;
        socket = null;
        open?.close();
      });
      connect();
    } else {
      sub.textContent = '';
    }

    render();
  };

  void start();

  return () => {
    alive = false;
    for (const cleanup of cleanups) cleanup();
    host.replaceChildren();
  };
}
