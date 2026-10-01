import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createComfyMock } from '@agenthub/mocks/comfy';
import type { JobType, NodeRegistration } from '@agenthub/shared';
import { JobRunner } from '../../node-daemon/src/job-runner.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const MEDIA_TYPES: JobType[] = ['image-gen', 'video-gen'];

export interface MediaNode {
  registration: NodeRegistration;
  /** Starts claiming; call once the node is registered. */
  start(): void;
  stop(): Promise<void>;
}

/**
 * The simulation's PC: the real daemon `JobRunner` with the real templates, rendering against the
 * ComfyUI mock instead of a GPU. Each run takes three history polls (~6 s), long enough to watch a
 * job go from waiting to rendering to landed in the Media view.
 */
export async function startMediaNode(opts: { hub: string; daemonToken: string; dataRoot: string }): Promise<MediaNode> {
  const comfy = createComfyMock({ pollsUntilDone: 3 });
  await comfy.listen({ port: 0, host: '127.0.0.1' });
  const comfyUrl = `http://127.0.0.1:${(comfy.server.address() as { port: number }).port}`;
  const registration: NodeRegistration = { name: 'sim-media', arch: 'x64', endpoints: [], jobTypes: MEDIA_TYPES, video: true };
  const runner = new JobRunner({
    hub: opts.hub,
    node: registration.name,
    types: MEDIA_TYPES,
    workspaceRoot: join(opts.dataRoot, 'media-node'),
    claimIntervalMs: 1000,
    authHeaders: { authorization: `Bearer ${opts.daemonToken}` },
    video: {
      comfyUrl,
      workflowTemplate: await readFile(join(REPO, 'deploy/amd/comfy/wan22-t2v.json'), 'utf8'),
      imageTemplate: await readFile(join(REPO, 'deploy/amd/comfy/qwen-image-t2i.json'), 'utf8'),
    },
  });
  return {
    registration,
    start: () => runner.start(),
    stop: async () => {
      await runner.stop();
      await comfy.close();
    },
  };
}
