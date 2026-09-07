import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import type { JobType, Tier } from '@agenthub/shared';

export interface ServingConfig { tier: Tier; model: string; port: number; maxStreams: number; cmd: string[]; }
/** Optional browser capability — only the Mac mini enables it. `port: 0` picks an ephemeral one. */
export interface BrowserConfig { enabled: boolean; port?: number; display?: string; headless?: boolean; }
export interface DaemonConfig {
  node: { name: string; arch: string };
  hub: string;
  /** Bearer token for every hub call; falls back to the `DAEMON_TOKEN` env var. */
  hubToken?: string;
  advertiseHost?: string;
  heartbeatMs?: number;
  serving?: ServingConfig[];
  jobTypes?: JobType[];
  workspaceRoot?: string;
  claimIntervalMs?: number;
  browser?: BrowserConfig;
}

export function loadConfig(path: string): DaemonConfig {
  const raw = load(readFileSync(path, 'utf8')) as Partial<DaemonConfig> | undefined;
  if (!raw?.node?.name || !raw.node.arch) throw new Error('daemon config: node.name/node.arch missing');
  if (!raw.hub) throw new Error('daemon config: hub missing');
  // `serving` is optional: a node that only hosts the shared browser, or only runs a job runner,
  // declares no model tier at all. Only when it *is* present must every entry be well-formed.
  const serving = raw.serving ?? [];
  if (!Array.isArray(serving)) throw new Error('daemon config: serving must be a list');
  for (const s of serving) {
    if (!s.tier || !s.model || !s.port || !s.maxStreams || !Array.isArray(s.cmd) || s.cmd.length === 0)
      throw new Error('daemon config: serving entry missing tier/model/port/maxStreams/cmd');
  }
  if (raw.browser !== undefined && typeof raw.browser.enabled !== 'boolean')
    throw new Error('daemon config: browser.enabled must be a boolean');
  const hasJobTypes = Array.isArray(raw.jobTypes) && raw.jobTypes.length > 0;
  if (serving.length === 0 && !raw.browser?.enabled && !hasJobTypes)
    throw new Error('daemon config: no capability (serving, jobTypes or browser) declared');
  raw.serving = serving;
  return raw as DaemonConfig;
}
