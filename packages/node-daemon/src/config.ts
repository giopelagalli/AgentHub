import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import type { JobType, Tier } from '@agenthub/shared';

export interface ServingConfig { tier: Tier; model: string; port: number; maxStreams: number; cmd: string[]; name?: string; priority?: number; }
/** Optional browser capability — only the Mac mini enables it. `port: 0` picks an ephemeral one. */
export interface BrowserConfig { enabled: boolean; port?: number; display?: string; headless?: boolean; }
/**
 * Marks this node as a hub candidate (spec §4.2). `hubCmd` is the argv that starts the hub itself
 * (e.g. `["node", "packages/hub/dist/main.js"]`); it is given the data-root variables derived from
 * `dataRoot` plus the allowlisted hub variables (`HUB_ENV_KEYS`), so a hub started here comes back
 * up configured the way the one it replaces was. `hubUrl` is where the started hub answers its
 * health probe; it defaults to `http://<advertiseHost>:4000`.
 */
export interface ControlNodeConfig {
  hubCmd: string[];
  dataRoot: string;
  hubUrl?: string;
  /**
   * Values for the variables the hub reads (`HUB_ENV_KEYS` in `hub-process.ts`), for a deployment
   * that would rather keep the hub's secrets in this file than in the daemon's own service unit.
   * Each name here wins over the daemon's environment; anything absent falls back to it.
   */
  env?: Record<string, string>;
}
/** Local ComfyUI used by the `video-gen` executor. `workflow` is a path to the JSON template. */
export interface VideoConfig { comfyUrl: string; workflow?: string; }
export interface DaemonConfig {
  node: { name: string; arch: string };
  hub: string;
  /**
   * Where else the hub may be after a control-node switch, tried in order once `hub` has stopped
   * answering. Give the tailnet alias (`http://hub.internal:4000`) first: it follows the hub on its
   * own and makes this list a backstop rather than the mechanism.
   */
  hubCandidates?: string[];
  /** Bearer token for every hub call; falls back to the `DAEMON_TOKEN` env var. */
  hubToken?: string;
  advertiseHost?: string;
  heartbeatMs?: number;
  serving?: ServingConfig[];
  jobTypes?: JobType[];
  workspaceRoot?: string;
  claimIntervalMs?: number;
  browser?: BrowserConfig;
  /** Named sets of serving entry names the hub can switch between (spec §4.3 exclusivity). */
  profiles?: Record<string, string[]>;
  /** Port for the local control server; ignored when the browser server is present (shared). */
  controlPort?: number;
  video?: VideoConfig;
  /** Present on a node that can host the hub; enables the `/control/hub/*` endpoints. */
  controlNode?: ControlNodeConfig;
}

export function loadConfig(path: string): DaemonConfig {
  const raw = load(readFileSync(path, 'utf8')) as Partial<DaemonConfig> | undefined;
  if (!raw?.node?.name || !raw.node.arch) throw new Error('daemon config: node.name/node.arch missing');
  if (!raw.hub) throw new Error('daemon config: hub missing');
  // `serving` is optional: a node that only hosts the shared browser, or only runs a job runner,
  // declares no model tier at all. Only when it *is* present must every entry be well-formed.
  const serving = raw.serving ?? [];
  if (!Array.isArray(serving)) throw new Error('daemon config: serving must be a list');
  const seenNames = new Set<string>();
  for (const s of serving) {
    if (!s.tier || !s.model || !s.port || !s.maxStreams || !Array.isArray(s.cmd) || s.cmd.length === 0)
      throw new Error('daemon config: serving entry missing tier/model/port/maxStreams/cmd');
    const name = s.name ?? `${s.tier}:${s.port}`;
    if (seenNames.has(name)) throw new Error(`daemon config: duplicate serving entry name ${name}`);
    seenNames.add(name);
  }
  if (raw.browser !== undefined && typeof raw.browser.enabled !== 'boolean')
    throw new Error('daemon config: browser.enabled must be a boolean');
  if (raw.profiles !== undefined) {
    const names = new Set(serving.map((s) => s.name ?? `${s.tier}:${s.port}`));
    for (const [profile, entries] of Object.entries(raw.profiles)) {
      if (!Array.isArray(entries)) throw new Error(`daemon config: profile ${profile} must be a list of serving entry names`);
      for (const entry of entries) {
        if (!names.has(entry)) throw new Error(`daemon config: profile ${profile} references unknown serving entry ${entry}`);
      }
    }
  }
  if (raw.video !== undefined) {
    // `COMFY_URL` is the per-node env fallback (plan Global Constraints) for the same value.
    const comfyUrl = raw.video.comfyUrl ?? process.env.COMFY_URL;
    if (!comfyUrl) throw new Error('daemon config: video.comfyUrl (or COMFY_URL) required');
    raw.video = { ...raw.video, comfyUrl };
  }
  if (raw.controlNode !== undefined) {
    const cn = raw.controlNode;
    if (!Array.isArray(cn.hubCmd) || cn.hubCmd.length === 0 || !cn.hubCmd.every((a) => typeof a === 'string'))
      throw new Error('daemon config: controlNode.hubCmd must be a non-empty argv list');
    if (typeof cn.dataRoot !== 'string' || !cn.dataRoot)
      throw new Error('daemon config: controlNode.dataRoot required');
    if (cn.env !== undefined && (typeof cn.env !== 'object' || cn.env === null || Object.values(cn.env).some((v) => typeof v !== 'string')))
      throw new Error('daemon config: controlNode.env must be a map of string values');
  }
  if (raw.hubCandidates !== undefined && (!Array.isArray(raw.hubCandidates) || !raw.hubCandidates.every((h) => typeof h === 'string')))
    throw new Error('daemon config: hubCandidates must be a list of hub urls');
  const hasJobTypes = Array.isArray(raw.jobTypes) && raw.jobTypes.length > 0;
  if (serving.length === 0 && !raw.browser?.enabled && !hasJobTypes && !raw.controlNode)
    throw new Error('daemon config: no capability (serving, jobTypes, browser or controlNode) declared');
  raw.serving = serving;
  return raw as DaemonConfig;
}
