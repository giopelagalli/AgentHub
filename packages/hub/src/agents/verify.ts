import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Milestone, MilestoneVerification } from '@agenthub/shared';
import { runShellTask } from '@agenthub/shared/shell';
import type { ProjectBundle } from '../projects/bundle.js';
import { patchMilestone } from '../projects/roadmap.js';
import { runSubagent, truncateResult, workspaceTools, type SubagentDeps, type Tool, type ToolContext } from './tools.js';

const VERIFY_TIMEOUT_MS = 120_000;
/** How much of the test output the milestone keeps and the manager gets back. */
const TEST_TAIL_LINES = 40;
/** How many changed files the reviewer is pointed at by name. */
const REVIEW_FILES_LIMIT = 100;
const REVIEW_REPORT_LIMIT = 4000;
const TEST_FILE_RE = /\.test\.(js|ts|mjs|cjs)$/;
const VERDICT_RE = /^\s*VERDICT:\s*(APPROVE|REQUEST_CHANGES)\b/gm;

type TestStatus = MilestoneVerification['tests'];
type ReviewStatus = MilestoneVerification['review'];

interface TestRun { status: TestStatus; label: string; tail: string }
interface Review { status: ReviewStatus; who: string; findings: string }

/**
 * The command that verifies this project, in `workspace/`: the manifest's `verifyCmd` when the
 * owner set one, else `npm test` when package.json declares a test script, else `node --test` when
 * there is a test/ directory with test files in it. Null means there is nothing to run.
 */
async function verifyCommand(bundle: ProjectBundle): Promise<{ cmd: string[]; label: string } | null> {
  const { verifyCmd } = await bundle.manifest();
  if (verifyCmd?.trim()) return { cmd: ['sh', '-c', verifyCmd], label: verifyCmd };
  const pkg = await readFile(join(bundle.workspace, 'package.json'), 'utf8')
    .then((raw) => JSON.parse(raw) as { scripts?: Record<string, unknown> }, () => null);
  if (typeof pkg?.scripts?.test === 'string') return { cmd: ['npm', 'test'], label: 'npm test' };
  const testDir = join(bundle.workspace, 'test');
  if (existsSync(testDir) && (await readdir(testDir).catch(() => [])).some((f) => TEST_FILE_RE.test(f))) {
    return { cmd: ['node', '--test'], label: 'node --test' };
  }
  return null;
}

async function runTests(bundle: ProjectBundle, ctx: ToolContext): Promise<TestRun> {
  const command = await verifyCommand(bundle);
  if (!command) return { status: 'skipped', label: 'no test command found', tail: '' };
  const result = await runShellTask(
    { cmd: command.cmd, timeoutMs: VERIFY_TIMEOUT_MS },
    { workspaceRoot: bundle.workspace, project: '.', onLine: ctx.log, signal: ctx.signal },
  );
  const passed = result.exitCode === 0 && !result.timedOut && !result.signal;
  const ending = result.timedOut ? `timed out after ${VERIFY_TIMEOUT_MS}ms` : `exit ${result.exitCode ?? `killed (${result.signal})`}`;
  const tail = `${result.stdoutTail ?? ''}\n${result.stderrTail ?? ''}`.split('\n').filter((l) => l.trim()).slice(-TEST_TAIL_LINES).join('\n');
  return { status: passed ? 'pass' : 'fail', label: `${command.label}, ${ending}`, tail };
}

/** The `## ` headings of the PRD — the shape of what the reviewer is judging against. */
const prdHeadings = (prd: string): string[] => prd.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3).trim());

function reviewTask(milestone: Milestone, headings: string[], files: string[]): string {
  const listed = files.slice(0, REVIEW_FILES_LIMIT).map((f) => `- ${f}`);
  if (files.length > REVIEW_FILES_LIMIT) listed.push(`- … and ${files.length - REVIEW_FILES_LIMIT} more`);
  return [
    `Review milestone ${milestone.id} — "${milestone.title}" — before it is marked done.`,
    `What it was meant to deliver: ${milestone.summary || '(no summary)'}`,
    ``,
    `The product's PRD has these sections: ${headings.length ? headings.join('; ') : '(none)'}.`,
    ``,
    `Files changed in the workspace since the milestone started:`,
    ...(listed.length ? listed : ['- (nothing changed)']),
    ``,
    `Read the changed code and its tests with read_file. Judge whether the milestone actually delivers what it says,`,
    `whether the code is correct, and whether the tests cover it.`,
    `End your report with a line that is exactly \`VERDICT: APPROVE\` or \`VERDICT: REQUEST_CHANGES\`, followed by`,
    `numbered concrete findings — for each: the file, what is wrong, and what to change. Approve only when there`,
    `is nothing that must change.`,
  ].join('\n');
}

/** The last VERDICT line in the report; a report without one is treated as asking for changes. */
function parseVerdict(report: string): ReviewStatus {
  let verdict: string | undefined;
  for (const m of report.matchAll(VERDICT_RE)) verdict = m[1];
  return verdict === 'APPROVE' ? 'approved' : 'changes';
}

/** The reviewer only reads: no write_file, no run_shell — it judges the change, it doesn't touch it. */
const REVIEWER_TOOLS: Tool[] = workspaceTools().filter((t) => t.def.name === 'read_file' || t.def.name === 'list_dir');

async function runReview(deps: SubagentDeps, ctx: ToolContext, bundle: ProjectBundle, milestone: Milestone): Promise<Review> {
  const reviewer = (await bundle.team()).find((m) => m.role === 'reviewer');
  if (!reviewer) return { status: 'skipped', who: 'no reviewer on the roster', findings: '' };
  const files = await bundle.changedWorkspaceFiles(milestone.startedCommit);
  const task = reviewTask(milestone, prdHeadings(await bundle.prd()), files);
  const res = await runSubagent(deps, ctx, { role: 'reviewer', member: reviewer, task, tools: REVIEWER_TOOLS });
  const report = res.text.trim();
  if (!report) {
    const findings = res.outcome === 'aborted'
      ? 'reviewer was cut short (the hub stopped, or the turn hit its time limit) without a report'
      : `reviewer ended (${res.outcome}) without a report`;
    return { status: 'changes', who: reviewer.name, findings };
  }
  return { status: parseVerdict(report), who: reviewer.name, findings: truncateResult(report, REVIEW_REPORT_LIMIT) };
}

/**
 * The only way a milestone becomes `done`: the project's tests run, the roster's reviewer reads what
 * changed, and both have to come back clean. Anything else leaves the milestone in progress and
 * hands the manager the evidence — the test tail, the reviewer's findings — to act on. Either way
 * the milestone records what was found, the decision log says so, and the turn feed sees it.
 */
export function completeMilestoneTool(deps: SubagentDeps): Tool {
  return {
    def: {
      type: 'tool', name: 'complete_milestone',
      description: 'Verify a milestone and mark it done: runs the project\'s tests in the workspace, then has the team\'s reviewer ' +
        'read the changes. The milestone becomes done only when both pass; otherwise it stays in-progress and you get the ' +
        'test output and the reviewer\'s findings back to act on.',
      parameters: { type: 'object', properties: { id: { type: 'string', description: 'Milestone id, e.g. "m2".' } }, required: ['id'] },
    },
    run: async (args, ctx) => {
      const id = (args as { id?: unknown })?.id;
      if (typeof id !== 'string') throw new Error('id must be a string');
      const bundle = ctx.bundle;
      if (!bundle) throw new Error('no project bundle in this session');
      const milestones = await bundle.roadmap();
      const milestone = milestones.find((m) => m.id === id);
      if (!milestone) throw new Error(`unknown milestone: ${id}`);

      const tests = await runTests(bundle, ctx);
      // Failing tests are a verdict already; the reviewer's time is spent on code that at least runs.
      const review: Review = tests.status === 'fail'
        ? { status: 'skipped', who: 'not run: tests failed', findings: '' }
        : await runReview(deps, ctx, bundle, milestone);
      // Done needs at least one positive signal (tests passed, or the reviewer approved) and no
      // negative one — two skipped checks (no test command, no reviewer on the roster) is not
      // evidence of anything, and must not wave a milestone through.
      const noEvidence = tests.status === 'skipped' && review.status === 'skipped';
      const done = !noEvidence && (tests.status === 'pass' || review.status === 'approved')
        && tests.status !== 'fail' && review.status !== 'changes';

      const summary = noEvidence
        ? 'no verification available: no test command and no reviewer on the roster — add one or set manifest.verifyCmd'
        : `tests: ${tests.status} (${tests.label}); review: ${review.status} (${review.who})`;
      const verification: MilestoneVerification = { tests: tests.status, review: review.status, at: Date.now(), notes: summary };
      const patch: Partial<Milestone> = { status: done ? 'done' : 'in-progress', verification };
      if (!done && !milestone.startedCommit) patch.startedCommit = await bundle.head();
      await bundle.writeRoadmap(patchMilestone(milestones, id, patch));
      await bundle.appendDecision({
        title: `Milestone ${id} ${done ? 'verified and done' : 'not done: verification failed'}`,
        rationale: `${milestone.title} — ${summary}.`,
        by: 'agent',
      });
      await bundle.commit(`agent: milestone ${id} ${done ? 'done (verified)' : 'verification failed'}`);
      ctx.onEvent?.({ kind: 'verify', milestoneId: id, tests: tests.status, review: review.status, summary });

      if (done) return `milestone ${id} is now done — ${summary}`;
      return [
        `milestone ${id} stays in-progress — ${summary}`,
        ...(tests.status === 'fail' ? [`test output (last ${TEST_TAIL_LINES} lines):`, tests.tail || '(no output)'] : []),
        ...(review.status === 'changes' ? [`reviewer findings (${review.who}):`, review.findings] : []),
        `Fix what is listed (delegate it), then call complete_milestone("${id}") again.`,
      ].join('\n');
    },
  };
}
