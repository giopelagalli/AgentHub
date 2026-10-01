import type { ChatBody, ScriptStep } from '@agenthub/mocks';
import {
  genericPrd, genericRoadmap, HABIT_PRD, HABIT_ROADMAP, POMODORO_CODE_MAP, POMODORO_PRD, POMODORO_ROADMAP,
} from './content.js';

/**
 * The simulation's "model": decides each mock reply from the request itself — which agent is asking
 * (read off its system prompt), and how far into its own conversation it is (the number of assistant
 * messages so far). Holding no state is what lets concurrent turns, subagents and chats share one
 * mock without stepping on each other's script.
 *
 * Keyed on the opening lines of the hub's own prompts (prompts.ts, prd.ts, chat.ts): if one of those
 * is reworded, the matching branch here falls through to a plain reply rather than breaking.
 */
export function simRespond(body: ChatBody): ScriptStep | undefined {
  const system = body.messages.find((m) => m.role === 'system')?.content ?? '';
  const user = body.messages.find((m) => m.role === 'user')?.content ?? '';
  const step = body.messages.filter((m) => m.role === 'assistant').length;
  const last = body.messages[body.messages.length - 1];
  const lastTool = last?.role === 'tool' ? last.content ?? '' : '';

  // Checked first: a chat with the manager or an employee reuses their turn prompt plus this framing.
  if (system.includes('You are chatting with the owner')) return { content: chatReply(user) };
  if (system.startsWith('You are a product lead writing the PRD')) return { content: draftPrd(user) };
  if (system.startsWith('You are a delivery lead sequencing')) return { content: JSON.stringify(roadmapFor(user), null, 2) };
  if (system.startsWith('You are the project orchestrator')) return managerStep(system, step, lastTool);
  if (system.startsWith("You are writing this project's code map")) {
    return step === 0
      ? { content: 'Reading the entry points before writing the map.', toolCalls: [{ name: 'write_code_map', arguments: { markdown: codeMapFor(system) } }] }
      : { content: 'Code map refreshed.' };
  }
  if (system.startsWith("You are the guide to this project's code")) {
    return { content: 'The timer is a pure state machine: `src/timer.mjs:2` builds the phase list once and `tick(now)` walks it from the start time, so tests pass a fake clock. No decision records why ticks are not counted; the PRD (Scalability) asks for wall-clock timing to avoid drift.' };
  }
  const sub = /^You are an? (coder|researcher|reviewer|browser-operator) subagent/.exec(system);
  if (sub) return subagentStep(sub[1]!, user, step);
  return undefined;
}

const titleOf = (text: string): string => /^title: (.+)$/m.exec(text)?.[1]?.trim() ?? 'Project';

function chatReply(message: string): string {
  const asked = message.trim().split('\n').pop()?.slice(0, 120) ?? '';
  return `(simulated reply) You asked: "${asked}". In the simulation I answer from a script, so this is a stand-in — ` +
    'the real model would read the PRD and the workspace before answering. The next turn would pick up the current milestone.';
}

/** The drafter's user message starts `# <title>` then `Owner intent: …`. */
function draftPrd(user: string): string {
  const title = /^# (.+)$/m.exec(user)?.[1]?.trim() ?? 'Project';
  const intent = /^Owner intent: (.+)$/m.exec(user)?.[1]?.trim() ?? title;
  const body = /pomodoro/i.test(title) ? POMODORO_PRD : /habit/i.test(title) ? HABIT_PRD : genericPrd(title, intent);
  return `${body}\n## Questions for the owner\n\n- Should abandoned sessions count toward the totals?\n- Is offline use a hard requirement for v1?\n`;
}

/** The roadmap request's user message is the PRD itself, whose first line is `# <title> — PRD`. */
function roadmapFor(prd: string) {
  const title = /^# (.+?)(?: — PRD)?$/m.exec(prd)?.[1]?.trim() ?? 'Project';
  return /pomodoro/i.test(title) ? POMODORO_ROADMAP : /habit/i.test(title) ? HABIT_ROADMAP : genericRoadmap(title);
}

function codeMapFor(system: string): string {
  return /pomodoro/i.test(titleOf(system))
    ? POMODORO_CODE_MAP
    : `# Code map\n\n## Where it starts\n- \`README.md:1\` — what the project is.\n`;
}

interface Current { id: string; title: string; summary: string }

/** The milestone the orchestrator prompt marks `← current milestone`, and the roadmap's counts. */
function roadmapState(system: string): { current: Current | null; done: number; total: number } {
  const lines = [...system.matchAll(/^- (m\d+) \[([a-z-]+)\] (.+?)(?: \([^)]*\))?( \*\*← current milestone\*\*)?\n {2}(.*)$/gm)];
  const hit = lines.find((l) => l[4]);
  return {
    current: hit ? { id: hit[1]!, title: hit[3]!, summary: hit[5]! } : null,
    done: lines.filter((l) => l[2] === 'done').length,
    total: lines.length,
  };
}

const kebab = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'feature';

function briefing(system: string, summary: string, done: number, total: number, blockers: string[], nextSteps: string[]): ScriptStep {
  return {
    content: 'Publishing the briefing.',
    toolCalls: [{
      name: 'publish_briefing',
      arguments: { title: titleOf(system), status: 'active', priority: 'project', summary, progress: { done, total }, blockers, nextSteps },
    }],
  };
}

/**
 * One manager turn: look around, delegate the current milestone to the coder, verify it with
 * complete_milestone (real tests, then the reviewer subagent), publish a briefing, stop.
 */
function managerStep(system: string, step: number, lastTool: string): ScriptStep {
  if (system.includes('prd.md is still the empty scaffold')) {
    return step === 0
      ? briefing(system, 'Nothing to build yet: the PRD is still the empty scaffold. Draft it (PRD tab) and generate a roadmap, then run a turn.',
        0, 0, ['The PRD has not been drafted'], ['Owner drafts the PRD', 'Generate the roadmap from it'])
      : { content: 'Waiting on the PRD.' };
  }
  const { current, done, total } = roadmapState(system);
  if (!current) {
    return step === 0
      ? briefing(system, total ? 'Every milestone on the roadmap is done and verified.' : 'There is no roadmap yet.', done, total, [],
        total ? ['Owner reviews the release'] : ['Generate the roadmap from the PRD'])
      : { content: 'Nothing left to do this turn.' };
  }
  const file = kebab(current.title);
  switch (step) {
    case 0:
      return {
        content: `Picking up ${current.id} — ${current.title}. Reading what exists before delegating.`,
        toolCalls: [{ name: 'list_dir', arguments: {} }, { name: 'read_file', arguments: { path: 'README.md' } }],
      };
    case 1:
      return {
        content: `Nothing implements ${current.title.toLowerCase()} yet. Handing it to Ada with the milestone summary as the spec.`,
        toolCalls: [{
          name: 'spawn_subagent',
          arguments: {
            role: 'coder', member: 'coder-1',
            task: `Implement ${current.id} — ${current.title}: ${current.summary} Write src/${file}.mjs and test/${file}.test.mjs; run node --test.`,
          },
        }],
      };
    case 2:
      return {
        content: `Ada reports the tests pass. Verifying ${current.id} before marking it done.`,
        toolCalls: [{ name: 'complete_milestone', arguments: { id: current.id } }],
      };
    case 3: {
      const verified = /is now done/.test(lastTool);
      return verified
        ? briefing(system, `${current.id} (${current.title}) is done: implemented by Ada, tests pass, Vex approved the change.`,
          done + 1, total, [], ['Start the next milestone'])
        : briefing(system, `${current.id} (${current.title}) is implemented but verification did not pass yet.`,
          done, total, [lastTool.split('\n')[0]!.slice(0, 200)], [`Fix the findings and call complete_milestone("${current.id}") again`]);
    }
    default:
      return { content: 'Turn complete.' };
  }
}

/** The coder writes a module and its test, runs them, reports; the reviewer reads and approves. */
function subagentStep(role: string, task: string, step: number): ScriptStep {
  if (role === 'coder') {
    const files = /Write (src\/[\w.-]+) and (test\/[\w.-]+);/.exec(task);
    if (!files) return { content: '(simulated) Done. Nothing in the task named files to write, so I changed nothing.' };
    const [, src, test] = files as unknown as [string, string, string];
    const name = src.replace(/^src\/|\.mjs$/g, '');
    const fn = name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
    switch (step) {
      case 0:
        return { content: 'Reading the existing layout first.', toolCalls: [{ name: 'list_dir', arguments: {} }] };
      case 1:
        return {
          content: `Writing ${src} and its test.`,
          toolCalls: [
            { name: 'write_file', arguments: { path: src, content: moduleSource(fn, task) } },
            { name: 'write_file', arguments: { path: test, content: testSource(fn, name) } },
          ],
        };
      case 2:
        return { content: 'Running the suite.', toolCalls: [{ name: 'run_shell', arguments: { cmd: ['node', '--test'] } }] };
      default:
        return { content: `Implemented ${fn}() in ${src} with a test in ${test}; node --test passes.` };
    }
  }
  if (role === 'reviewer') {
    // The coder named its module after the milestone; review that one, else the first changed source.
    const own = `src/${kebab(/Review milestone m\d+ — "(.+?)"/.exec(task)?.[1] ?? '')}.mjs`;
    const changed = task.includes(`- ${own}`) ? own : /^- (src\/\S+)$/m.exec(task)?.[1] ?? 'README.md';
    return step === 0
      ? { content: `Reading ${changed}.`, toolCalls: [{ name: 'read_file', arguments: { path: changed } }] }
      : { content: `The change does what the milestone says and the test covers it. Nothing must change.\n\nVERDICT: APPROVE` };
  }
  return { content: `(simulated ${role}) Looked into it; nothing blocking. A real model would report findings here.` };
}

function moduleSource(fn: string, task: string): string {
  const summary = task.split('\n')[0]!.replace(/ Write src\/.*$/, '');
  return [
    `// ${summary}`,
    `export function ${fn}(options = {}) {`,
    `  return { ...options, enabled: true };`,
    `}`,
    ``,
  ].join('\n');
}

function testSource(fn: string, name: string): string {
  return [
    `import { test } from 'node:test';`,
    `import assert from 'node:assert/strict';`,
    `import { ${fn} } from '../src/${name}.mjs';`,
    ``,
    `test('${fn} is enabled and keeps its options', () => {`,
    `  assert.deepEqual(${fn}({ minutes: 25 }), { minutes: 25, enabled: true });`,
    `});`,
    ``,
  ].join('\n');
}
