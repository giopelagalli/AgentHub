import type { FastifyPluginAsync } from 'fastify';
import { harnessStatus } from './detect.js';

/**
 * Which harnesses this hub host can actually run. The employee drawer reads it so it never offers
 * a harness whose CLI is missing — picking one that cannot start would only fail at turn time.
 */
export const harnessRoutes: FastifyPluginAsync<{ doorBase?: () => string | null }> = async (app, opts) => {
  app.get('/api/harnesses', async () => harnessStatus(opts.doorBase?.()));
};
