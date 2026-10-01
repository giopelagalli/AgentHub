// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLAUDE_CODE_LOCAL_ONLY_REASON, type HarnessInfo, type ProjectManifest, type TeamMemberView } from '@agenthub/shared';
import { fillHarnessField } from '../src/pages/project/controls.js';
import { openProjectSettings, type SettingsHandle } from '../src/pages/project/settings.js';

/**
 * The project's Harness row in the settings sheet, and the drawer's "Project default (…)" option,
 * in a DOM (happy-dom, this file only — decision 0052). The hub is a stubbed `fetch`.
 */

const ALL: HarnessInfo[] = [
  { kind: 'builtin', available: true },
  { kind: 'pi', available: true, version: '0.73.1' },
  { kind: 'claude-code', available: false, version: '2.1.0', reason: 'claude is not signed in on this host' },
];
const BUILTIN_ONLY: HarnessInfo[] = [
  { kind: 'builtin', available: true },
  { kind: 'pi', available: false },
  { kind: 'claude-code', available: false, reason: 'claude is not installed on this host' },
];

function manifest(extra: Partial<ProjectManifest> = {}): ProjectManifest {
  return {
    schema: 1, slug: 'demo', title: 'Demo', status: 'active', priority: 'project', intent: 'ship it',
    links: [], createdAt: 0, updatedAt: 0, index: [], ...extra,
  } as ProjectManifest;
}

let fetchMock: ReturnType<typeof vi.fn>;
let sheet: SettingsHandle | undefined;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  sheet?.close();
  sheet = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function open(project: ProjectManifest, harnesses: HarnessInfo[]): HTMLElement {
  sheet = openProjectSettings(document.body, {
    project: () => project,
    catalog: () => null,
    harnesses: () => harnesses,
    roster: () => null,
    budget: () => undefined,
    cost: () => '',
    onTeamChanged: async () => {},
    onScheduleChanged: () => {},
  });
  return document.body;
}

const harnessRow = (root: HTMLElement): HTMLElement | undefined =>
  [...root.querySelectorAll<HTMLElement>('.srow')].find((r) => r.querySelector('.srow__label')?.textContent === 'Harness');

describe("the settings sheet's Harness row", () => {
  it('offers every kind, disables the ones this host cannot run with their reason, and posts a change', async () => {
    const row = harnessRow(open(manifest({ harness: 'pi' }), ALL));
    expect(row).toBeDefined();
    const select = row!.querySelector('select')!;
    expect(select.value).toBe('pi');
    const options = [...select.options];
    expect(options.map((o) => o.value)).toEqual(['builtin', 'pi', 'claude-code']);
    expect(options.map((o) => o.disabled)).toEqual([false, false, true]);
    const hints = [...row!.querySelectorAll('.srow__hint')].map((h) => h.textContent);
    expect(hints).toContain('Claude Code: claude is not signed in on this host');

    select.value = 'builtin';
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/projects/demo/harness');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ harness: 'builtin' });
  });

  it('disables claude-code on a Local-only project, saying why', () => {
    const available = ALL.map((h) => (h.kind === 'claude-code' ? { kind: h.kind, available: true, version: '2.1.0' } : h));
    const row = harnessRow(open(manifest({ modelPolicy: { prefer: 'local' } }), available));
    const claude = [...row!.querySelectorAll('option')].find((o) => o.value === 'claude-code')!;
    expect(claude.disabled).toBe(true);
    expect([...row!.querySelectorAll('.srow__hint')].map((h) => h.textContent))
      .toContain(`Claude Code: ${CLAUDE_CODE_LOCAL_ONLY_REASON}`);
    // No harness set reads as the built-in loop.
    expect(row!.querySelector('select')!.value).toBe('builtin');
  });

  it('is not there when only the built-in loop runs on this host', () => {
    expect(harnessRow(open(manifest(), BUILTIN_ONLY))).toBeUndefined();
    sheet?.close();
    expect(harnessRow(open(manifest(), []))).toBeUndefined();
  });
});

describe("the drawer's Harness field", () => {
  const member = { id: 'coder-1', name: 'Ada', role: 'coder', avatar: 'robot-amber', createdAt: 0 } as unknown as TeamMemberView;

  it("names the project's default and still offers the built-in loop explicitly", () => {
    const slot = document.createElement('div');
    fillHarnessField(slot, 'demo', member, ALL, 'pi');
    expect(slot.hidden).toBe(false);
    const options = [...slot.querySelectorAll('option')];
    expect(options.map((o) => [o.value, o.textContent])).toEqual([
      ['', 'Project default (pi)'],
      ['builtin', 'Built-in loop'],
      ['pi', 'pi 0.73.1'],
    ]);
    expect(slot.querySelector('select')!.value).toBe('');
  });

  it('stays empty when only the built-in loop runs on this host', () => {
    const slot = document.createElement('div');
    fillHarnessField(slot, 'demo', member, BUILTIN_ONLY, 'builtin');
    expect(slot.hidden).toBe(true);
    expect(slot.childElementCount).toBe(0);
  });
});
