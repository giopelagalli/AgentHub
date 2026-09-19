import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { optionsFromEnv } from '../src/options.js';

/**
 * The environment → `createHub` mapping `main.ts` is built on. It matters on its own because a
 * control-node switch hands the new hub an environment and nothing else: whatever this function
 * fails to read is a capability the hub silently loses when it moves.
 */
const quiet = () => {};

describe('optionsFromEnv', () => {
  it('roots everything the hub writes under DATA_ROOT', () => {
    const { options } = optionsFromEnv({ DATA_ROOT: '/srv/agenthub', CONTROL_NODE_NAME: 'strix' }, quiet);
    expect(options.dbPath).toBe(join('/srv/agenthub', 'hub.db'));
    expect(options.projectsRoot).toBe(join('/srv/agenthub', 'projects'));
    expect(options.assistant?.memoryRoot).toBe(join('/srv/agenthub', 'memory'));
    // Browser recordings included: a switched hub must not leave the owner's timelines behind.
    expect(options.browser?.recordingsRoot).toBe(join('/srv/agenthub', 'media', 'browser'));
    expect(options.controlNode).toEqual({ dataRoot: '/srv/agenthub', name: 'strix' });
  });

  it('lets the explicit roots win, and disables switching without DATA_ROOT', () => {
    const { options } = optionsFromEnv({ HUB_DB: '/tmp/x.db', PROJECTS_ROOT: '/tmp/p', MEMORY_ROOT: '/tmp/m' }, quiet);
    expect(options.dbPath).toBe('/tmp/x.db');
    expect(options.projectsRoot).toBe('/tmp/p');
    expect(options.assistant?.memoryRoot).toBe('/tmp/m');
    expect(options.controlNode).toBeUndefined();
    expect(options.browser).toBeUndefined();
  });

  it('binds 0.0.0.0 by default and the address HUB_HOST names otherwise', () => {
    expect(optionsFromEnv({}, quiet)).toMatchObject({ host: '0.0.0.0', port: 4000 });
    expect(optionsFromEnv({ HUB_HOST: '100.101.102.103', PORT: '4100' }, quiet))
      .toMatchObject({ host: '100.101.102.103', port: 4100 });
  });

  it('turns auth on with a password and reads the proxy trust in both forms', () => {
    const open = optionsFromEnv({}, quiet);
    expect(open.options.auth).toBeUndefined();

    const guarded = optionsFromEnv({ HUB_PASSWORD: 'p', HUB_SESSION_SECRET: 's', DAEMON_TOKEN: 'd', TRUST_PROXY: '1' }, quiet);
    expect(guarded.options.auth).toEqual({ password: 'p', sessionSecret: 's', daemonToken: 'd', trustProxy: true });
    expect(optionsFromEnv({ HUB_PASSWORD: 'p', TRUST_PROXY: '100.64.0.1' }, quiet).options.auth?.trustProxy).toBe('100.64.0.1');
    expect(optionsFromEnv({ HUB_PASSWORD: 'p' }, quiet).options.auth?.trustProxy).toBeUndefined();
  });

  it('reports the telegram pair only when both halves are a private chat', () => {
    expect(optionsFromEnv({ TELEGRAM_BOT_TOKEN: 't' }, quiet).telegram).toBeNull();
    expect(optionsFromEnv({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_OWNER_CHAT_ID: '-100' }, quiet).telegram).toBeNull();
    expect(optionsFromEnv({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_OWNER_CHAT_ID: '42' }, quiet).telegram)
      .toEqual({ token: 't', ownerChatId: '42' });
  });

  it('enables the cloud tier only on CLOUD_ANTHROPIC=1, with optional model overrides', () => {
    expect(optionsFromEnv({}, quiet).options.cloud).toBeUndefined();
    expect(optionsFromEnv({ CLOUD_ANTHROPIC: '0' }, quiet).options.cloud).toBeUndefined();
    // Enabled with no overrides: the models are `createHub`'s defaults, not something env spells out.
    expect(optionsFromEnv({ CLOUD_ANTHROPIC: '1' }, quiet).options.cloud).toEqual({ anthropic: {} });
    expect(optionsFromEnv({ CLOUD_ANTHROPIC: '1', CLOUD_ORCHESTRATOR_MODEL: 'claude-opus-5', CLOUD_WORKER_MODEL: 'claude-haiku-4-5' }, quiet).options.cloud)
      .toEqual({ anthropic: { orchestratorModel: 'claude-opus-5', workerModel: 'claude-haiku-4-5' } });
  });

  it('enables the fireworks tier on a key (or CLOUD_FIREWORKS=1), with optional model overrides', () => {
    expect(optionsFromEnv({}, quiet).options.cloud).toBeUndefined();
    // Having the key is the switch — there is no way to reach Fireworks without one.
    expect(optionsFromEnv({ FIREWORKS_API_KEY: 'fw' }, quiet).options.cloud).toEqual({ fireworks: {} });
    expect(optionsFromEnv({ CLOUD_FIREWORKS: '1' }, quiet).options.cloud).toEqual({ fireworks: {} });
    expect(optionsFromEnv({ FIREWORKS_API_KEY: 'fw', FIREWORKS_ORCHESTRATOR_MODEL: 'a', FIREWORKS_WORKER_MODEL: 'b' }, quiet).options.cloud)
      .toEqual({ fireworks: { orchestratorModel: 'a', workerModel: 'b' } });
    // Both providers can be on at once; each keeps its own overrides.
    expect(optionsFromEnv({ CLOUD_ANTHROPIC: '1', FIREWORKS_API_KEY: 'fw' }, quiet).options.cloud)
      .toEqual({ anthropic: {}, fireworks: {} });
    expect(optionsFromEnv({ FIREWORKS_API_KEY: 'fw', FIREWORKS_HARD_MODELS: '1' }, quiet).options.cloud)
      .toEqual({ fireworks: { hardModels: true } });
  });

  it('keeps an external tool only when its key is present and its provider is known', () => {
    const { options } = optionsFromEnv({ XAI_API_KEY: 'x', SEARCH_API_KEY: 'k', SEARCH_PROVIDER: 'tavily' }, quiet);
    expect(options.external).toMatchObject({ xaiKey: 'x', search: { provider: 'tavily', key: 'k' } });
    expect(optionsFromEnv({ SEARCH_API_KEY: 'k', SEARCH_PROVIDER: 'nope' }, quiet).options.external?.search).toBeUndefined();
    expect(optionsFromEnv({}, quiet).options.external).toEqual({});
  });

  it('turns the scheduler off only on AUTO_TURNS=0', () => {
    expect(optionsFromEnv({}, quiet).options.autoTurns).toBeUndefined();
    expect(optionsFromEnv({ AUTO_TURNS: '1' }, quiet).options.autoTurns).toBeUndefined();
    expect(optionsFromEnv({ AUTO_TURNS: '0' }, quiet).options.autoTurns).toBe(false);
  });

  it('reads MAX_TURNS_PER_DAY as a whole number of at least 1, and drops anything else with a log line', () => {
    expect(optionsFromEnv({}, quiet).options.maxTurnsPerDay).toBeUndefined();
    expect(optionsFromEnv({ MAX_TURNS_PER_DAY: '12' }, quiet).options.maxTurnsPerDay).toBe(12);
    for (const bad of ['0', '-3', '2.5', 'lots']) {
      const lines: string[] = [];
      expect(optionsFromEnv({ MAX_TURNS_PER_DAY: bad }, (l) => lines.push(l)).options.maxTurnsPerDay).toBeUndefined();
      expect(lines.filter((l) => l.includes('MAX_TURNS_PER_DAY'))).toHaveLength(1);
    }
  });
});
