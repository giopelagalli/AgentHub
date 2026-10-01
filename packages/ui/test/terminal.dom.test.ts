// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ViewContext } from '../src/views/parts.js';

/**
 * The lazy Terminal mount (decision 0041), with `terminal-mount.js` mocked so no xterm loads: a
 * dispose before the import resolves never mounts, and a chunk that fails to load says so.
 */

const ctx = { slug: 'demo' } as unknown as ViewContext;

afterEach(() => {
  vi.doUnmock('../src/views/terminal-mount.js');
  vi.resetModules();
});

describe('mountTerminal', () => {
  it('never mounts the screen when disposed before the import resolves', async () => {
    const mountTerminalScreen = vi.fn(() => () => {});
    let release: (() => void) | null = null;
    vi.doMock('../src/views/terminal-mount.js', async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { mountTerminalScreen };
    });
    const { mountTerminal } = await import('../src/views/terminal.js');
    const host = document.createElement('div');
    const dispose = mountTerminal(host, ctx);
    expect(host.textContent).toContain('Loading the terminal');
    dispose();
    expect(host.children).toHaveLength(0);
    // The import is in flight once the mock's factory has started waiting.
    await vi.waitFor(() => expect(release).not.toBeNull());
    (release as unknown as () => void)();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mountTerminalScreen).not.toHaveBeenCalled();
    expect(host.children).toHaveLength(0);
  });

  it('shows the missing message when the chunk fails to load', async () => {
    vi.doMock('../src/views/terminal-mount.js', () => { throw new Error('chunk 404'); });
    const { mountTerminal, TERMINAL_MISSING } = await import('../src/views/terminal.js');
    const host = document.createElement('div');
    mountTerminal(host, ctx);
    await vi.waitFor(() => expect(host.textContent).toContain(TERMINAL_MISSING));
  });

  it('puts the loading box back with an error when the mount itself throws', async () => {
    vi.doMock('../src/views/terminal-mount.js', () => ({
      mountTerminalScreen: (host: HTMLElement) => {
        host.appendChild(document.createElement('div')).className = 'term term--half-built';
        throw new Error('boom');
      },
    }));
    const { mountTerminal } = await import('../src/views/terminal.js');
    const host = document.createElement('div');
    mountTerminal(host, ctx);
    await vi.waitFor(() => expect(host.textContent).toContain('could not be started'));
    expect(host.querySelector('.term--half-built')).toBeNull();
    expect(host.children).toHaveLength(1);
  });
});
