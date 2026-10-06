// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamMemberView } from '@agenthub/shared';
import { memberAbilitiesField } from '../src/pages/project/controls.js';

/**
 * The drawer's "Can make" switches (decision 0073), in a DOM (happy-dom). The hub is a stubbed
 * `fetch`.
 */

let fetchMock: ReturnType<typeof vi.fn>;
const ok = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  fetchMock = vi.fn(async () => ok());
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const member = (extra: Partial<TeamMemberView> = {}): TeamMemberView =>
  ({ id: 'coder-1', name: 'Ada', role: 'coder', avatar: 'robot-amber', createdAt: 0, ...extra }) as unknown as TeamMemberView;

const RENDERS = { image: true, video: true };

function mount(m: TeamMemberView, renderers: { image: boolean; video: boolean } | undefined = RENDERS) {
  const field = memberAbilitiesField('demo', m, renderers);
  document.body.appendChild(field);
  const toggle = (name: string) => [...field.querySelectorAll('label')]
    .find((l) => l.textContent === name)!.querySelector<HTMLInputElement>('input.switch')!;
  return { field, images: toggle('Images'), videos: toggle('Videos') };
}

const flip = (input: HTMLInputElement) => {
  input.checked = !input.checked;
  input.dispatchEvent(new Event('change'));
};

describe("the drawer's Can make switches", () => {
  it('starts from the member\'s abilities, and a designer with none set has both on', () => {
    const coder = mount(member({ abilities: ['video'] }));
    expect([coder.images.checked, coder.videos.checked]).toEqual([false, true]);
    const plain = mount(member());
    expect([plain.images.checked, plain.videos.checked]).toEqual([false, false]);
    const designer = mount(member({ role: 'designer' }));
    expect([designer.images.checked, designer.videos.checked]).toEqual([true, true]);
    const switchedOff = mount(member({ role: 'designer', abilities: [] }));
    expect([switchedOff.images.checked, switchedOff.videos.checked]).toEqual([false, false]);
  });

  it('saves the whole set on a change', async () => {
    const { images } = mount(member({ abilities: ['video'] }));
    flip(images);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/projects/demo/team/coder-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ abilities: ['image', 'video'] });
  });

  it('puts both switches back to the last saved set when the hub refuses', async () => {
    const { images, videos } = mount(member({ abilities: ['image'] }));
    flip(videos);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(document.querySelector('.toast')).not.toBeNull());
    fetchMock.mockImplementation(async () => new Response('{"error":"invalid abilities"}', { status: 400, headers: { 'content-type': 'application/json' } }));
    flip(images);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body))).toEqual({ abilities: ['video'] });
    await vi.waitFor(() => expect(images.checked).toBe(true));
    expect(videos.checked).toBe(true);
  });

  it('says quietly when no machine can render, and still saves', async () => {
    const none = mount(member(), { image: false, video: false });
    expect(none.field.querySelector('.drawer__hint')?.textContent)
      .toBe('No machine can render yet — renders are refused until one joins.');
    flip(none.videos);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const stillsOnly = mount(member(), { image: true, video: false });
    expect(stillsOnly.field.querySelector('.drawer__hint')?.textContent)
      .toBe('No machine can render videos yet — renders are refused until one joins.');
    expect(mount(member()).field.querySelector('.drawer__hint')).toBeNull();
    expect(mount(member(), undefined).field.querySelector('.drawer__hint')).toBeNull();
  });
});
