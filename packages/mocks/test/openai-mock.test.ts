import { describe, it, expect, afterEach } from 'vitest';
import { createMockOpenAI } from '../src/openai-mock.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
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
});
