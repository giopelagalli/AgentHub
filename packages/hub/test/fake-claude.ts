/**
 * A stand-in for the `claude` CLI on PATH, for the harness tests: no test may reach the real one,
 * which would spend the host's subscription. It answers `--version` and `auth status --json` like
 * claude 2.1 does (decision 0064) — `FAKE_CLAUDE_AUTH` picks the login: `subscription` (default),
 * `signed-out`, `api-key` or `garbage` — and otherwise emits the `-p --output-format stream-json
 * --verbose` event shapes captured from the real CLI, driven by `FAKE_CLAUDE_MODE`. It records its
 * argv, cwd and the environment variables the adapter is responsible for to `FAKE_CLAUDE_LOG`.
 *
 * CommonJS on purpose: an extensionless executable is what `claude` is on PATH, and node runs one as CJS.
 */
export const FAKE_CLAUDE = `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { dirname, resolve } = require('node:path');

const argv = process.argv.slice(2);
if (argv.includes('--version')) { process.stdout.write('2.1.0-fake (Claude Code)\\n'); process.exit(0); }
if (argv[0] === 'auth') {
  const auth = process.env.FAKE_CLAUDE_AUTH || 'subscription';
  if (auth === 'garbage') { process.stdout.write('Logged in, probably\\n'); process.exit(0); }
  if (auth === 'signed-out') { process.stdout.write(JSON.stringify({ loggedIn: false, authMethod: 'none' })); process.exit(1); }
  // A hub ANTHROPIC_API_KEY reaching the CLI would make it an API-key login; say so if one did.
  const key = auth === 'api-key' || !!process.env.ANTHROPIC_API_KEY;
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: key ? 'api_key' : 'claude.ai', apiProvider: 'firstParty' }));
  process.exit(0);
}

const log = process.env.FAKE_CLAUDE_LOG;
if (log) {
  const env = {};
  for (const k of ['HOME', 'TMPDIR', 'CLAUDE_CODE_TMPDIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'GITHUB_TOKEN']) env[k] = process.env[k] ?? null;
  writeFileSync(log, JSON.stringify({ argv, cwd: process.cwd(), env }));
}

const model = 'claude-fake-1';
const emit = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
const usage = { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 20 };
let n = 0;
// The real CLI emits one \`assistant\` event per content block, repeating the message id and usage.
const say = (block, id = 'msg_' + ++n) =>
  emit({ type: 'assistant', message: { id, model, type: 'message', role: 'assistant', content: [block], usage }, parent_tool_use_id: null });
const answer = (id, content, isError = false) =>
  emit({ type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content, is_error: isError }] }, parent_tool_use_id: null });
const write = (id, file) => {
  const full = resolve(process.cwd(), file);
  say({ type: 'tool_use', id, name: 'Write', input: { file_path: full, content: 'x' } });
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, 'x');
  answer(id, 'File created successfully at: ' + full);
};
const result = (text, over = {}) => emit({
  type: 'result', subtype: 'success', is_error: false, num_turns: 3, result: text, stop_reason: 'end_turn',
  total_cost_usd: 0.5,
  usage: { input_tokens: 30, cache_creation_input_tokens: 300, cache_read_input_tokens: 3000, output_tokens: 60 },
  modelUsage: { [model]: { inputTokens: 30, outputTokens: 60, cacheReadInputTokens: 3000, cacheCreationInputTokens: 300, costUSD: 0.5 } },
  ...over,
});

emit({ type: 'system', subtype: 'init', cwd: process.cwd(), model, tools: ['Read'], permissionMode: 'dontAsk', apiKeySource: 'none' });
const mode = process.env.FAKE_CLAUDE_MODE;
if (mode === 'write') {
  write('t1', 'src/app.js');
  // A Bash command that writes a file names nothing in its input: only the workspace scan sees it.
  say({ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm run build' } });
  mkdirSync(resolve('dist'), { recursive: true });
  writeFileSync(resolve('dist/out.js'), 'x');
  answer('t2', 'built');
  // A refused write is not a file written.
  say({ type: 'tool_use', id: 't3', name: 'Write', input: { file_path: resolve('refused.txt'), content: 'x' } });
  answer('t3', '<tool_use_error>Error: No such tool available: Write.</tool_use_error>', true);
  say({ type: 'text', text: 'Wrote src/app.js.' });
  result('Wrote src/app.js and built dist/out.js.');
} else if (mode === 'signed-out') {
  say({ type: 'text', text: 'Not logged in · Please run /login' });
  result('Not logged in · Please run /login', { is_error: true, usage: undefined, modelUsage: {} });
  process.exit(1);
} else if (mode === 'many') {
  for (let i = 0; i < 100; i++) {
    say({ type: 'tool_use', id: 'r' + i, name: 'Read', input: { file_path: resolve('a.txt') } });
    answer('r' + i, 'a');
  }
  setInterval(() => {}, 1000);
} else if (mode === 'hang') {
  const child = spawn('sleep', ['1000'], { stdio: 'ignore' });
  writeFileSync(log + '.pid', String(child.pid));
  setInterval(() => {}, 1000);
} else {
  say({ type: 'text', text: 'Nothing to change.' });
  result('Nothing to change.');
}
`;
