import { parseSseFrames, type SseEvent } from './sse.js';

/**
 * A POST whose answer is an SSE token stream, read to the end. The PRD drafter and the roadmap
 * generator both work this way; the chat drawer has its own copy because it also has to deal with
 * queueing and pending actions.
 *
 * Tokens arrive through `onToken`; the resolved value is the `done` frame, so a caller can read
 * `full` and `questions` off it. Aborting `signal` rejects with an `AbortError`, which the caller
 * is expected to recognise as its own cancel rather than a failure.
 */
export async function streamPost(
  url: string,
  body: unknown,
  signal: AbortSignal,
  onToken: (token: string) => void,
): Promise<SseEvent> {
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal,
  });
  if (!response.ok || !response.body) throw new Error(`hub replied ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let rest = '';
  let last: SseEvent = {};

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const parsed = parseSseFrames(rest + decoder.decode(value, { stream: true }));
    rest = parsed.rest;
    for (const event of parsed.events) {
      if (event.token !== undefined) onToken(event.token);
      // An error frame is the hub telling us the run failed; nothing after it is worth waiting for.
      if (event.error !== undefined) throw new Error(event.error);
      if (event.done) last = event;
    }
  }
  return last;
}
