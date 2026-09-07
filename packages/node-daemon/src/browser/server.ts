import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import type { BrowserDriver } from './driver.js';

/**
 * The daemon's local browser API — a thin HTTP shell over one `BrowserDriver`. The hub's
 * `BrowserProxy` is its only client, so there is no lease logic here: whoever reaches this port
 * drives the browser, and binding is restricted by the daemon (loopback, or the tailnet address).
 *
 * A malformed request is a 400; a driver failure (bad selector, navigation error) is a 502 with the
 * driver's message, so the caller can tell "I asked wrong" from "the browser couldn't".
 */
export function createBrowserServer(driver: BrowserDriver): FastifyInstance {
  const app = Fastify();

  const run = async <T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> => {
    try {
      return await fn();
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  };

  app.post('/browser/navigate', async (req, reply) => {
    const { url } = (req.body ?? {}) as { url?: unknown };
    if (typeof url !== 'string' || url === '') return reply.code(400).send({ error: 'url required' });
    return run(reply, () => driver.navigate(url));
  });

  app.post('/browser/read', async (_req, reply) => run(reply, () => driver.read()));

  app.post('/browser/click', async (req, reply) => {
    const { selector } = (req.body ?? {}) as { selector?: unknown };
    if (typeof selector !== 'string' || selector === '') return reply.code(400).send({ error: 'selector required' });
    return run(reply, () => driver.click(selector));
  });

  app.post('/browser/type', async (req, reply) => {
    const { selector, text, submit } = (req.body ?? {}) as { selector?: unknown; text?: unknown; submit?: unknown };
    if (typeof selector !== 'string' || selector === '') return reply.code(400).send({ error: 'selector required' });
    if (typeof text !== 'string') return reply.code(400).send({ error: 'text required' });
    return run(reply, () => driver.type(selector, text, submit === true));
  });

  app.get('/browser/screenshot', async (_req, reply) => {
    try {
      const jpeg = await driver.screenshot();
      return reply.type('image/jpeg').send(jpeg);
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  // Derived from a read rather than a seventh driver method: the state is always the live one, and
  // nothing polls this route at frame rate (the screencast uses /browser/screenshot).
  app.get('/browser/state', async (_req, reply) => run(reply, async () => (await driver.read()).state));

  return app;
}
