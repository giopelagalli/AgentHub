import { describe, it, expect } from 'vitest';
import {
  CONNECT_NOTE, accountLogins, githubLineText, githubReturn, repoFieldMode, repoFieldNote,
  repoLabel, withoutGithubParam, type GithubStatus,
} from '../src/github.js';

const connected: GithubStatus = {
  configured: true, method: 'app', connected: true,
  installUrl: '/api/github/connect',
  installations: [{ id: 7, login: 'acme', type: 'Organization', manageUrl: 'https://github.com/settings/installations/7' }],
};
const notConnected: GithubStatus = { configured: true, method: 'app', connected: false, installUrl: '/api/github/connect' };
const withToken: GithubStatus = { configured: true, method: 'token', connected: false };
const nothing: GithubStatus = { configured: false, method: 'none', connected: false };

describe('repoFieldMode', () => {
  it('maps the four hubs onto the four Repository fields', () => {
    expect(repoFieldMode(connected)).toBe('picker');
    expect(repoFieldMode(notConnected)).toBe('connect');
    expect(repoFieldMode(withToken)).toBe('typed');
    expect(repoFieldMode(nothing)).toBe('none');
  });

  it('treats a hub too old to answer `connected` as not connected', () => {
    expect(repoFieldMode({ configured: true, method: 'app' })).toBe('connect');
  });
});

describe('the lines beside the field', () => {
  it('says who is connected, or what pressing Connect does', () => {
    expect(repoFieldNote(connected)).toBe('Connected as acme.');
    expect(repoFieldNote(notConnected)).toBe(CONNECT_NOTE);
    expect(repoFieldNote(withToken)).toMatch(/token on the hub/);
    expect(repoFieldNote(nothing)).toMatch(/public ones clone without it/);
  });

  it('says the same thing in fewer words on the Cluster page', () => {
    expect(githubLineText(connected)).toBe('GitHub: connected as acme');
    expect(githubLineText(notConnected)).toBe('GitHub: not connected');
    expect(githubLineText(withToken)).toBe('GitHub: a token on the hub');
    expect(githubLineText(nothing)).toBe('GitHub: not configured');
    expect(githubLineText(null)).toBe('GitHub: reading…');
  });

  it('lists every connected account', () => {
    expect(accountLogins(connected)).toEqual(['acme']);
    expect(accountLogins(notConnected)).toEqual([]);
  });
});

describe('repoLabel', () => {
  it('names the repository, whether it is private, and its default branch', () => {
    expect(repoLabel({ fullName: 'acme/portal', private: true, defaultBranch: 'main', updatedAt: '' }))
      .toBe('acme/portal · private · main');
    expect(repoLabel({ fullName: 'acme/site', private: false, defaultBranch: 'trunk', updatedAt: '' }))
      .toBe('acme/site · trunk');
  });
});

describe('coming back from GitHub', () => {
  it('reads the callback parameter and nothing else', () => {
    expect(githubReturn('?github=connected')).toBe('connected');
    expect(githubReturn('?github=connected&page=cluster')).toBe('connected');
    expect(githubReturn('?github=something')).toBeNull();
    expect(githubReturn('')).toBeNull();
  });

  it('takes the parameter off the address bar and leaves the rest alone', () => {
    expect(withoutGithubParam('http://hub/?github=connected')).toBe('/');
    expect(withoutGithubParam('http://hub/?github=connected&page=cluster')).toBe('/?page=cluster');
    expect(withoutGithubParam('http://hub/?page=cluster#x')).toBe('/?page=cluster#x');
  });
});
