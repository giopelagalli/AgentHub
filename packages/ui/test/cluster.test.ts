import { describe, it, expect } from 'vitest';
import type { NodeInfo, UsageReport } from '@agenthub/shared';
import { cloudSpendText, enrollmentExpiry, nodeActions } from '../src/pages/cluster.js';

function node(overrides: Partial<NodeInfo> = {}): NodeInfo {
  return {
    id: 1, name: 'spark', arch: 'arm64', endpoints: [], status: 'online', lastHeartbeat: 0, jobTypes: [],
    owner: 'admin',
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

describe('enrollmentExpiry', () => {
  const now = 1_700_000_000_000;
  const inMinutes = (m: number) => enrollmentExpiry(now + m * 60_000, now);

  it('says hours for a freshly minted token', () => {
    expect(inMinutes(24 * 60)).toBe('Expires in 24 hours.');
    expect(inMinutes(60)).toBe('Expires in 1 hour.');
  });

  it('says minutes under the hour, singular at one', () => {
    expect(inMinutes(59)).toBe('Expires in 59 minutes.');
    expect(inMinutes(1)).toBe('Expires in 1 minute.');
  });

  it('tells the owner to mint a new one once it has run out', () => {
    expect(inMinutes(0)).toBe('This command has expired — press Add node for a fresh one.');
    expect(inMinutes(-10)).toBe('This command has expired — press Add node for a fresh one.');
  });
});

describe('cloudSpendText', () => {
  const report = (cloudUsdToday: number, maxCloudUsdPerDay: number | null): UsageReport => ({
    since: 0, usd: cloudUsdToday, tokens: { prompt: 0, cached: 0, completion: 0 },
    byModel: [], bySubject: [], cap: { maxCloudUsdPerDay, cloudUsdToday },
  });

  it('names the cap beside the spend when the owner has set one', () => {
    expect(cloudSpendText(report(1.2, 5))).toBe('Cloud spend: $1.20 in the last 24 h · cap $5.00');
  });

  it('leaves the cap off when there is none, and shows a plain zero rather than a dash', () => {
    expect(cloudSpendText(report(1.2, null))).toBe('Cloud spend: $1.20 in the last 24 h');
    expect(cloudSpendText(report(0, null))).toBe('Cloud spend: $0.00 in the last 24 h');
  });

  it('says it is still reading until the first answer lands', () => {
    expect(cloudSpendText(null)).toBe('Cloud spend: reading…');
  });
});
