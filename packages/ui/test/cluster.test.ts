import { describe, it, expect } from 'vitest';
import type { NodeInfo } from '@agenthub/shared';
import { nodeActions } from '../src/pages/cluster.js';

function node(overrides: Partial<NodeInfo> = {}): NodeInfo {
  return {
    id: 1, name: 'spark', arch: 'arm64', endpoints: [], status: 'online', lastHeartbeat: 0, jobTypes: [],
    ...overrides,
  };
}

describe('nodeActions', () => {
  it('offers drain and remove for an online node that is not draining', () => {
    expect(nodeActions(node())).toEqual(['drain', 'remove']);
  });

  it('offers undrain and remove for a draining node', () => {
    expect(nodeActions(node({ draining: true }))).toEqual(['undrain', 'remove']);
  });

  it('offers nothing for a synthetic cloud node', () => {
    expect(nodeActions(node({ name: 'cloud-anthropic', arch: 'cloud' }))).toEqual([]);
  });
});
