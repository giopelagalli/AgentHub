import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { MediaList } from '@agenthub/shared';
import { listMedia, mediaFilePath, MediaRequestError, NoRendererError, type MediaDesk } from './media.js';
import type { ProjectBundle } from './bundle.js';
import type { ProjectService } from './service.js';
import { InvalidSlugError } from './schema.js';

export interface MediaRoutesOptions {
  projects: ProjectService;
  media: MediaDesk;
}

/**
 * FR-E2 — a project's media: list, serve, and queue from a prompt. Owner-only like every `/api/*`
 * route `auth.ts` does not name otherwise; the files themselves are resolved by `mediaFilePath`,
 * which keeps them inside the bundle's `media/`.
 */
export async function mediaRoutes(app: FastifyInstance, opts: MediaRoutesOptions): Promise<void> {
  const { projects, media } = opts;

  /** The bundle, or null once a 400/404 has been sent — the same answers every project route gives. */
  const bundleFor = async (slug: string, reply: FastifyReply): Promise<ProjectBundle | null> => {
    try {
      return await projects.get(slug);
    } catch (err) {
      reply.code(err instanceof InvalidSlugError ? 400 : 404)
        .send({ error: err instanceof InvalidSlugError ? 'invalid slug' : 'unknown project' });
      return null;
    }
  };

  app.get('/api/projects/:slug/media', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const bundle = await bundleFor(slug, reply);
    if (!bundle) return reply;
    const list: MediaList = { assets: await listMedia(bundle.dir), jobs: media.jobs(slug), renderers: media.renderers() };
    return list;
  });

  app.get('/api/projects/:slug/media/:file', async (req, reply) => {
    const { slug, file } = req.params as { slug: string; file: string };
    const bundle = await bundleFor(slug, reply);
    if (!bundle) return reply;
    const found = await mediaFilePath(bundle.dir, file);
    if (!found) return reply.code(404).send({ error: 'no such media file' });
    // A generated file never changes under its name; the UI's grid can keep it.
    // nosniff: the bytes are a render, never a document — a browser must not guess them into HTML.
    return reply.type(found.contentType).header('cache-control', 'private, max-age=3600')
      .header('x-content-type-options', 'nosniff').send(createReadStream(found.path));
  });

  app.post('/api/projects/:slug/media', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    if (!(await bundleFor(slug, reply))) return reply;
    try {
      const job = media.request(slug, req.body);
      return reply.code(201).send(job);
    } catch (err) {
      if (err instanceof MediaRequestError) return reply.code(err instanceof NoRendererError ? 409 : 400).send({ error: err.message });
      throw err;
    }
  });
}
