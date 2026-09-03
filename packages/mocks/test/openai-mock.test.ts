import { describe, it, expect, afterEach } from 'vitest';
import { createMockOpenAI, type MockOpenAI } from '../src/openai-mock.js';

let app: MockOpenAI;
afterEach(async () => { await app?.close(); });

describe('mock openai server', () => {
  it('serves /v1/models', async () => {
    app = createMockOpenAI();
    const res = await app.inject({ method: 'GET', url: '/v1/models' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data[0].id).toBe('mock-model');
  });

  it('answers non-streaming chat completions with an echo', async () => {
    app = createMockOpenAI();
    const res = await app.inject({
      method: 'POST', url: '/v1/chat/completions',
      payload: { model: 'mock-model', messages: [{ role: 'user', content: 'hi there' }] },
    });
    expect(res.json().choices[0].message.content).toBe('echo: hi there');
  });

  it('streams SSE chunks ending with [DONE]', async () => {
    app = createMockOpenAI({ tokenDelayMs: 1 });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-model', stream: true, messages: [{ role: 'user', content: 'one two three' }] }),
    });
    const text = await res.text();
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const contents = [...text.matchAll(/data: (\{.*\})/g)]
      .map((m) => JSON.parse(m[1]).choices[0].delta.content ?? '').join('');
    expect(contents).toBe('echo: one two three');
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('streams a scripted tool call as OpenAI tool_calls deltas, then falls back to echo', async () => {
    app = createMockOpenAI({ script: [{ toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] }] });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-model', stream: true, messages: [{ role: 'user', content: 'read it' }] }),
    });
    const text = await res.text();
    const chunks = [...text.matchAll(/data: (\{.*\})/g)].map((m) => JSON.parse(m[1]));
    const fragments = chunks.map((c) => c.choices[0].delta.tool_calls?.[0]).filter(Boolean);
    expect(fragments.length).toBeGreaterThanOrEqual(2); // arguments split into >=2 fragments
    expect(fragments[0].id).toBe('call_0');
    expect(fragments[0].function.name).toBe('read_file');
    const assembledArgs = fragments.map((f) => f.function.arguments).join('');
    expect(JSON.parse(assembledArgs)).toEqual({ path: 'a.txt' });
    const finishChunk = chunks.find((c) => c.choices[0].finish_reason);
    expect(finishChunk.choices[0].finish_reason).toBe('tool_calls');
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);

    // script is exhausted now — falls back to echo
    const res2 = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-model', messages: [{ role: 'user', content: 'anything' }] }),
    });
    const body2 = await res2.json();
    expect(body2.choices[0].message.content).toBe('echo: anything');
  });

  it('echoes tool-result content when the last message has role tool, and records lastRequest', async () => {
    app = createMockOpenAI();
    const res = await app.inject({
      method: 'POST', url: '/v1/chat/completions',
      payload: { model: 'mock-model', messages: [{ role: 'user', content: 'hi' }, { role: 'tool', tool_call_id: 'call_0', content: 'file contents' }] },
    });
    expect(res.json().choices[0].message.content).toBe('echo: file contents');
    expect(app.lastRequest().messages.at(-1).content).toBe('file contents');
    expect(app.requests.length).toBeGreaterThan(0);
  });
});
