import type { MediaAsset, MediaKind, MediaList } from '@agenthub/shared';
import { getJson, sendJson } from '../api.js';
import { button, el } from '../dom.js';
import { icon } from '../icons.js';
import {
  assetCaption, blockedReason, CLIP_SECONDS, hasJobsInFlight, jobLine, mediaRequest, mediaUrl, SIZE_PRESETS,
} from '../media.js';
import { toast } from '../toast.js';
import { segmented } from '../toolbar.js';
import { note, type ViewContext } from './parts.js';

/**
 * Docs → Media (FR-E2): what the project's GPU machine rendered for it — stills and clips, each
 * with the prompt and settings that made it — and a prompt box to ask for another. The box is
 * built once and survives every refresh, so a prompt being typed is never wiped by the poll.
 */

/** Quick while something renders, slow otherwise — an agent may still add an asset. */
const FAST_POLL_MS = 2500;
const SLOW_POLL_MS = 15_000;

export function mountMedia(host: HTMLElement, ctx: ViewContext): () => void {
  let list: MediaList | null = null;
  let failure = '';
  let alive = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let kind: MediaKind = 'image';
  let preset = SIZE_PRESETS.image[0]!.id;
  let clipSeconds: number = CLIP_SECONDS[0];
  let sending = false;
  /** The grid is rebuilt only when the assets change, so thumbnails don't flicker on every poll. */
  let gridKey = '';

  const root = el('div', 'media');
  const compose = el('form', 'media__compose');
  const jobs = el('div', 'media__jobs');
  const gallery = el('div', 'media__gallery');
  root.append(compose, jobs, gallery);
  host.replaceChildren(root);

  // --- the prompt box ---------------------------------------------------------------------------
  const prompt = el('textarea', 'input media__prompt');
  prompt.rows = 2;
  prompt.placeholder = 'Describe an image — subject, style, colours, framing…';
  prompt.setAttribute('aria-label', 'Prompt');
  const kindSwitch = segmented([{ id: 'image', label: 'Image' }, { id: 'video', label: 'Video' }] as const, kind, (id) => {
    kind = id;
    preset = SIZE_PRESETS[kind][0]!.id;
    prompt.placeholder = kind === 'image' ? 'Describe an image — subject, style, colours, framing…' : 'Describe a short clip — what moves, how the camera goes…';
    drawOptions();
    drawState();
  }, 'Kind');
  const options = el('div', 'media__options');
  const generate = button('Generate', 'btn btn--primary');
  generate.type = 'submit';
  const blocked = el('p', 'media__blocked');
  const row = el('div', 'media__row');
  row.append(kindSwitch.root, options, generate);
  compose.append(prompt, row, blocked);

  function drawOptions(): void {
    const sizes = segmented(SIZE_PRESETS[kind].map((p) => ({ id: p.id, label: p.label })), preset, (id) => { preset = id; }, 'Size');
    options.replaceChildren(sizes.root);
    for (const node of sizes.root.querySelectorAll<HTMLElement>('[data-id]')) {
      const p = SIZE_PRESETS[kind].find((s) => s.id === node.dataset.id);
      if (p) node.title = `${p.width}×${p.height}`;
    }
    if (kind === 'video') {
      const length = el('select', 'select media__seconds');
      length.setAttribute('aria-label', 'Length');
      for (const s of CLIP_SECONDS) {
        const opt = el('option', undefined, `${s} s`);
        opt.value = String(s);
        opt.selected = s === clipSeconds;
        length.appendChild(opt);
      }
      length.addEventListener('change', () => { clipSeconds = Number(length.value); });
      options.appendChild(length);
    }
  }

  prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); compose.requestSubmit(); }
  });
  compose.addEventListener('submit', (e) => {
    e.preventDefault();
    if (sending || !prompt.value.trim() || blockedReason(list, kind)) return;
    sending = true;
    drawState();
    sendJson(`/api/projects/${ctx.slug}/media`, mediaRequest(kind, prompt.value, preset, clipSeconds))
      .then(() => { prompt.value = ''; return load(); })
      .catch((err: Error) => toast(err.message, 'error'))
      .finally(() => { sending = false; drawState(); });
  });

  // --- jobs and the grid --------------------------------------------------------------------------
  function drawState(): void {
    const reason = blockedReason(list, kind);
    blocked.textContent = reason ?? '';
    blocked.hidden = !reason;
    prompt.disabled = !!reason;
    generate.disabled = !!reason || sending;
    generate.textContent = sending ? 'Queuing…' : 'Generate';

    jobs.replaceChildren(...(list?.jobs ?? []).slice().reverse().map((j) => {
      const line = el('div', `media__job media__job--${j.status}`);
      line.append(el('span', 'media__jobdot'), el('span', 'media__jobprompt', j.prompt), el('span', 'media__jobstate', jobLine(j)));
      return line;
    }));
    jobs.hidden = !list?.jobs.length;

    if (failure && !list) {
      gallery.replaceChildren(note(`Could not load media: ${failure}`, 'error'));
      gridKey = '';
      return;
    }
    if (!list) {
      gallery.replaceChildren(note('Loading media…'));
      return;
    }
    const key = list.assets.map((a) => a.file).join('|');
    if (key === gridKey && gallery.childElementCount) return;
    gridKey = key;
    if (!list.assets.length) {
      const empty = el('div', 'media__empty');
      empty.append(icon('image', 28), el('p', 'media__emptyline', 'No images or clips yet. Describe one above — it renders on your GPU machine and lands in this project’s media/ folder.'));
      gallery.replaceChildren(empty);
      return;
    }
    const grid = el('div', 'media__grid');
    grid.append(...list.assets.map((a) => tile(ctx.slug, a)));
    gallery.replaceChildren(grid);
  }

  async function load(): Promise<void> {
    try {
      const next = await getJson<MediaList>(`/api/projects/${ctx.slug}/media`);
      if (!alive) return;
      list = next;
      failure = '';
    } catch (err) {
      if (!alive) return;
      failure = (err as Error).message;
    }
    drawState();
  }

  const poll = (): void => {
    timer = setTimeout(() => { void load().finally(() => { if (alive) poll(); }); }, hasJobsInFlight(list) ? FAST_POLL_MS : SLOW_POLL_MS);
  };

  drawOptions();
  drawState();
  void load().finally(() => { if (alive) poll(); });

  return () => {
    alive = false;
    clearTimeout(timer);
  };
}

/** One asset: the picture (or the clip, its first frame as the poster), its prompt and settings. */
function tile(slug: string, asset: MediaAsset): HTMLElement {
  const figure = el('figure', `media__tile media__tile--${asset.kind}`);
  const frame = el('div', 'media__frame');
  const url = mediaUrl(slug, asset.file);
  if (asset.kind === 'video') {
    const video = el('video', 'media__thumb');
    video.src = `${url}#t=0.1`;
    video.preload = 'metadata';
    video.controls = true;
    video.muted = true;
    video.playsInline = true;
    frame.appendChild(video);
  } else {
    const link = el('a', 'media__open');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.title = 'Open full size';
    const img = el('img', 'media__thumb');
    img.src = url;
    img.alt = asset.prompt;
    img.loading = 'lazy';
    link.appendChild(img);
    frame.appendChild(link);
  }
  const caption = el('figcaption', 'media__caption');
  const words = el('p', 'media__words', asset.prompt);
  words.title = asset.params.negativePrompt ? `${asset.prompt}\n\nAvoid: ${asset.params.negativePrompt}` : asset.prompt;
  caption.append(words, el('p', 'media__meta', assetCaption(asset)), el('p', 'media__file', `media/${asset.file}`));
  figure.append(frame, caption);
  return figure;
}
