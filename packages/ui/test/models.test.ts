import { describe, it, expect } from 'vitest';
import type { ModelCatalog, ModelPolicy } from '@agenthub/shared';
import {
  memberModelOptions, modelOptions, policyFromValue, policyPillText, shortModel, valueFromPolicy, workerOptions,
} from '../src/models.js';

const GLM = 'accounts/fireworks/models/glm-5p3';
const FLASH = 'accounts/fireworks/models/glm-5p3-flash';
const KIMI = 'accounts/fireworks/models/kimi-k3';

// KIMI is deliberately left out of `prices`, and Anthropic reports null for its one id: both are
// models the hub has no price for, which the picker must say out loud rather than pass over.
const catalog: ModelCatalog = {
  local: [{ node: 'spark', tier: 'worker', model: 'qwen-local' }],
  cloud: [
    {
      provider: 'fireworks', models: [GLM, FLASH], disabled: [KIMI],
      prices: {
        [GLM]: { input: 1.40, cachedInput: 0.26, output: 4.40 },
        [FLASH]: { input: 0.15, cachedInput: 0.03, output: 0.50 },
      },
      configured: { orchestrator: GLM, worker: FLASH },
    },
    {
      provider: 'anthropic', models: ['claude-opus-4-8'], prices: { 'claude-opus-4-8': null },
      configured: { orchestrator: 'claude-opus-4-8', worker: 'claude-sonnet-5' },
    },
  ],
};

const GLM_PRICE = ' — $1.40 in / $4.40 out per M';
const FLASH_PRICE = ' — $0.15 in / $0.50 out per M';
const UNKNOWN = ' — price unknown';

describe('modelOptions', () => {
  it('offers auto and local only until the catalog arrives', () => {
    expect(modelOptions(null)).toEqual([
      { value: 'auto', label: 'Auto (local first)' },
      { value: 'local', label: 'Local only' },
    ]);
  });

  it('lists each provider\'s defaults entry and one entry per model', () => {
    expect(modelOptions(catalog)).toEqual([
      { value: 'auto', label: 'Auto (local first)' },
      { value: 'local', label: 'Local only' },
      { value: 'cloud', label: 'Any cloud' },
      { value: 'cloud:fireworks', label: 'Fireworks (default models)' },
      { value: `cloud:fireworks:${GLM}`, label: `Fireworks: glm-5p3${GLM_PRICE}` },
      { value: `cloud:fireworks:${FLASH}`, label: `Fireworks: glm-5p3-flash${FLASH_PRICE}` },
      { value: `cloud:fireworks:${KIMI}`, label: `Fireworks: kimi-k3 (off)${UNKNOWN}`, disabled: true },
      { value: 'cloud:anthropic', label: 'Anthropic (default models)' },
      { value: 'cloud:anthropic:claude-opus-4-8', label: `Anthropic: claude-opus-4-8${UNKNOWN}` },
    ]);
  });

  it('gives the worker select the provider\'s models plus a "same model" entry', () => {
    expect(workerOptions(catalog, 'fireworks')).toEqual([
      { value: '', label: 'Worker: same model' },
      { value: GLM, label: `Worker: glm-5p3${GLM_PRICE}` },
      { value: FLASH, label: `Worker: glm-5p3-flash${FLASH_PRICE}` },
      { value: KIMI, label: `Worker: kimi-k3 (off)${UNKNOWN}`, disabled: true },
    ]);
    expect(workerOptions(null, 'fireworks')).toHaveLength(1);
  });
});

describe('memberModelOptions', () => {
  it('leads with "Project default" ahead of the project\'s own option list', () => {
    expect(memberModelOptions(catalog)).toEqual([
      { value: '', label: 'Project default' },
      ...modelOptions(catalog),
    ]);
    expect(memberModelOptions(null)).toEqual([
      { value: '', label: 'Project default' },
      ...modelOptions(null),
    ]);
  });
});

describe('option values and policies', () => {
  it('round-trips every option the select offers', () => {
    for (const option of modelOptions(catalog)) {
      expect(valueFromPolicy(policyFromValue(option.value))).toBe(option.value);
    }
  });

  it('sets both tiers to the one model the owner picked', () => {
    expect(policyFromValue(`cloud:fireworks:${GLM}`)).toEqual({
      prefer: 'cloud', provider: 'fireworks', orchestratorModel: GLM, workerModel: GLM,
    });
    expect(policyFromValue('cloud:fireworks')).toEqual({ prefer: 'cloud', provider: 'fireworks' });
    expect(policyFromValue('local')).toEqual({ prefer: 'local' });
    expect(policyFromValue('auto')).toEqual({ prefer: 'auto' });
  });

  it('shows the orchestrator\'s model when the worker was refined separately', () => {
    const split: ModelPolicy = { prefer: 'cloud', provider: 'fireworks', orchestratorModel: GLM, workerModel: FLASH };
    expect(valueFromPolicy(split)).toBe(`cloud:fireworks:${GLM}`);
    expect(valueFromPolicy(undefined)).toBe('auto');
  });
});

describe('policyPillText', () => {
  it('reads as the short form the header pill and the allocation table show', () => {
    expect(policyPillText(undefined)).toBe('auto');
    expect(policyPillText({ prefer: 'auto' })).toBe('auto');
    expect(policyPillText({ prefer: 'local' })).toBe('local only');
    expect(policyPillText({ prefer: 'cloud' })).toBe('cloud');
    expect(policyPillText({ prefer: 'cloud', provider: 'fireworks' })).toBe('Fireworks');
    expect(policyPillText({ prefer: 'cloud', provider: 'fireworks', orchestratorModel: GLM, workerModel: GLM }))
      .toBe('Fireworks: glm-5p3');
    expect(policyPillText({ prefer: 'cloud', provider: 'fireworks', orchestratorModel: GLM, workerModel: FLASH }))
      .toBe('Fireworks: glm-5p3 / glm-5p3-flash');
    // Only the worker tier is overridden — say so, rather than a bare model name that would read
    // as if the orchestrator used it too.
    expect(policyPillText({ prefer: 'cloud', provider: 'anthropic', workerModel: 'claude-sonnet-5' }))
      .toBe('Anthropic: default / claude-sonnet-5');
  });

  it('shortens an id to its last path segment', () => {
    expect(shortModel(GLM)).toBe('glm-5p3');
    expect(shortModel('claude-opus-4-8')).toBe('claude-opus-4-8');
  });
});
