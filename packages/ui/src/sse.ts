/** One decoded hub SSE payload; the hub sends exactly one of these shapes. */
export interface SseEvent {
  token?: string;
  done?: boolean;
  full?: string;
  error?: string;
}

const DATA_LINE = /^data: (\{.*\})$/m;

/**
 * Splits a Server-Sent-Events buffer into decoded payloads. A chunk boundary
 * can fall anywhere, so whatever follows the last complete frame comes back as
 * `rest` for the caller to prepend to the next chunk. Frames without a JSON
 * `data:` line (comments, keep-alives, garbage) are dropped.
 */
export function parseSseFrames(buf: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  let rest = buf;
  let index = rest.indexOf('\n\n');

  while (index >= 0) {
    const frame = rest.slice(0, index);
    rest = rest.slice(index + 2);
    const match = DATA_LINE.exec(frame);
    if (match) {
      try {
        events.push(JSON.parse(match[1]) as SseEvent);
      } catch {
        // A frame we cannot decode is not worth killing the stream over.
      }
    }
    index = rest.indexOf('\n\n');
  }

  return { events, rest };
}
