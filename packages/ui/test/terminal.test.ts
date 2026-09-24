import { describe, it, expect } from 'vitest';
import { terminalSummary } from '../src/artifacts.js';
import { MAX_RECONNECTS, encodeInput, parseNotice, reconnectAfter, reconnectDelay, resizeFrame, terminalUrl } from '../src/views/terminal.js';

// The view itself needs a DOM and a socket; these are its pure parts — the frames that go over the
// wire in both directions, and the one line the big button shows.

describe('terminal frames', () => {
  it('builds the socket url from the page\'s own origin', () => {
    expect(terminalUrl({ protocol: 'http:', host: 'spark:4000' }, 'demo'))
      .toBe('ws://spark:4000/api/projects/demo/terminal');
    expect(terminalUrl({ protocol: 'https:', host: 'hub.rosenroot.com' }, 'my-app'))
      .toBe('wss://hub.rosenroot.com/api/projects/my-app/terminal');
  });

  it('sends whole, positive window sizes', () => {
    expect(JSON.parse(resizeFrame(80, 24))).toEqual({ type: 'resize', cols: 80, rows: 24 });
    // fit() measures in fractional characters; the hub only admits integers.
    expect(JSON.parse(resizeFrame(99.6, 30.2))).toEqual({ type: 'resize', cols: 100, rows: 30 });
    expect(JSON.parse(resizeFrame(0, 0))).toEqual({ type: 'resize', cols: 1, rows: 1 });
  });

  it('sends keystrokes as utf-8 bytes', () => {
    expect([...encodeInput('ls\r')]).toEqual([108, 115, 13]);
    expect([...encodeInput('é')]).toEqual([195, 169]);
  });

  it('reads the hub\'s notices and ignores anything else', () => {
    expect(parseNotice(JSON.stringify({ type: 'error', message: 'too many terminals' })))
      .toEqual({ type: 'error', message: 'too many terminals' });
    expect(parseNotice(JSON.stringify({ type: 'closed', reason: 'idle' })))
      .toEqual({ type: 'closed', message: 'idle' });
    expect(parseNotice('not json')).toBeNull();
    expect(parseNotice(JSON.stringify({ type: 'state' }))).toBeNull();
  });

  it('backs off between reconnects and then holds', () => {
    expect([0, 1, 2, 3, 4, 9].map(reconnectDelay)).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
  });

  it('dials again after an unexplained drop, and never after the hub said why', () => {
    expect(reconnectAfter(null, 0)).toBe(true);
    // The idle timeout, a shell that exited, the hub going down: every one of these arrives as a
    // `closed` frame, and reconnecting would undo it — the idle timeout would be a no-op and a
    // shell that exits at once would become a spawn loop.
    expect(reconnectAfter(parseNotice(JSON.stringify({ type: 'closed', reason: 'idle' })), 0)).toBe(false);
    expect(reconnectAfter(parseNotice(JSON.stringify({ type: 'closed', reason: 'shell exited (0)' })), 0)).toBe(false);
    expect(reconnectAfter(parseNotice(JSON.stringify({ type: 'error', message: 'too many terminals' })), 0)).toBe(false);
    // And the retries are finite, so a hub that is simply not there is not dialled forever.
    expect(reconnectAfter(null, MAX_RECONNECTS - 1)).toBe(true);
    expect(reconnectAfter(null, MAX_RECONNECTS)).toBe(false);
  });
});

describe('terminal button', () => {
  it('says whether the shell is on screen', () => {
    expect(terminalSummary(false)).toMatchObject({ label: 'Terminal', caption: 'A shell in the workspace', hint: 'closed' });
    expect(terminalSummary(true).hint).toBe('open');
  });
});
