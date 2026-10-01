import type { PreviewStatus, ProjectManifest, TeamRoster } from '@agenthub/shared';
import { codeSummary, docsSummary, prdSummary, previewSummary, roadmapSummary, type ArtifactSummary, type DocState } from '../../artifacts.js';
import { avatarSvg } from '../../avatars.js';
import type { CodeSummaryDoc } from '../../code/model.js';
import type { DocsIndex } from '../../docs.js';
import { button, el } from '../../dom.js';
import { icon, type IconName } from '../../icons.js';
import { orgChartModel, type OrgCard } from '../../org.js';
import { overviewInvite, overviewNow, recentTurns, turnTone, type CodePart, type OverviewInvite, type PlanPart, type ProjectTab } from '../../overview.js';
import type { Briefing } from '../../panels/master.js';
import { projectSourceRow } from '../../panels/source.js';
import type { PrdDoc } from '../../prd.js';
import type { RoadmapDoc } from '../../roadmap.js';
import { turnsOf, type UiState } from '../../store.js';
import {
  activeWho, doingCaption, formatElapsed, formatTime, formatUsd, openSubagents, runningTurn, truncate, turnDuration, whoView,
  type TurnRecord,
} from '../../turns.js';

/**
 * The Overview tab: where the project is (the "Now" block), who is on it (the team as a row of
 * faces), and what happened last (three lines of activity). While there is nothing to show yet it
 * leads with one invitation instead — describe it, plan it, run it.
 *
 * Drawn whole from what the page already holds; nothing here fetches. The page redraws it when a
 * document lands or a turn moves, and `renderOverview` keeps keyboard focus where it was.
 */

/** One document and where its fetch got to. */
export interface Held<T> {
  state: DocState;
  doc: T | null;
}

export interface OverviewData {
  project: ProjectManifest;
  state: UiState;
  roster: TeamRoster | null;
  rosterState: 'loading' | 'ready' | 'failed';
  prd: Held<PrdDoc>;
  roadmap: Held<RoadmapDoc>;
  docs: Held<DocsIndex>;
  code: Held<CodeSummaryDoc>;
  preview: Held<PreviewStatus>;
  briefing: Held<Briefing>;
  /** "$0.42 today", or empty while unknown. */
  cost: string;
}

export interface OverviewActions {
  openCard(card: OrgCard): void;
  openTab(tab: ProjectTab, part?: PlanPart | CodePart): void;
  invite(kind: OverviewInvite['kind']): void;
  addEmployee(): void;
}

/** Which way each "In this project" row goes. */
const GLANCE: { summary: (d: OverviewData) => ArtifactSummary; icon: IconName; tab: ProjectTab; part?: PlanPart | CodePart }[] = [
  { summary: (d) => prdSummary(d.prd.state, d.prd.doc), icon: 'doc', tab: 'plan', part: 'prd' },
  { summary: (d) => roadmapSummary(d.roadmap.state, d.roadmap.doc), icon: 'queue', tab: 'plan', part: 'roadmap' },
  { summary: (d) => docsSummary(d.docs.state, d.docs.doc), icon: 'folder', tab: 'docs' },
  { summary: (d) => codeSummary(d.code.state, d.code.doc, Date.now()), icon: 'terminal', tab: 'code', part: 'files' },
  { summary: (d) => previewSummary(d.preview.state, d.preview.doc), icon: 'globe', tab: 'code', part: 'preview' },
];

/** Who is doing what in a running turn, as a sentence: "Ada is reading src/app.ts". */
function liveLine(turn: TurnRecord, roster: TeamRoster | null): string {
  const who = activeWho(turn);
  const doing = doingCaption(turn, who, 80);
  return doing ? `${whoView(who, roster).name} is ${doing}` : 'Starting…';
}

const INVITE_ICONS: Record<OverviewInvite['kind'], IconName> = { prd: 'sparkle', roadmap: 'queue', turn: 'play' };

function section(title: string, aside?: HTMLElement): { root: HTMLElement; body: HTMLElement } {
  const root = el('section', 'ov__section');
  const head = el('div', 'ov__head');
  head.appendChild(el('h2', 'ov__title', title));
  if (aside) head.appendChild(aside);
  const body = el('div', 'ov__body');
  root.append(head, body);
  return { root, body };
}

/** The invitation: one sentence, one button. */
function inviteNode(invite: OverviewInvite, actions: OverviewActions): HTMLElement {
  const box = el('div', 'ov__invite');
  const badge = el('span', 'ov__inviteicon');
  badge.appendChild(icon(INVITE_ICONS[invite.kind], 22));
  const go = button(invite.action, 'btn btn--primary');
  go.dataset.key = `invite-${invite.kind}`;
  go.addEventListener('click', () => actions.invite(invite.kind));
  box.append(badge, el('p', 'ov__inviteline', invite.line), go);
  return box;
}

/** The "Now" block: the milestone, how far along, the briefing, the next step. */
function nowNode(data: OverviewData, invite: OverviewInvite | null, actions: OverviewActions): HTMLElement | null {
  const now = overviewNow(data.roadmap.doc, data.briefing.doc);
  const held = turnsOf(data.state, data.project.slug);
  const running = runningTurn(held.turns);
  if (!now.milestone && !now.briefing && !running) return null;

  const box = el('div', 'ov__now');
  const eyebrow = el('p', 'ov__eyebrow', running ? 'Working on' : now.milestoneCurrent ? 'Current milestone' : 'Next up');
  box.appendChild(eyebrow);
  box.appendChild(el('h3', 'ov__milestone', now.milestone ?? (running ? 'The team is working' : 'No milestone in progress')));

  if (running) {
    const line = el('p', 'ov__live');
    const clock = el('span', 'num', formatElapsed(Date.now() - running.startedAt));
    clock.dataset.elapsed = String(running.startedAt);
    line.append(el('span', 'dot dot--working dot--pulse'), el('span', 'ov__livetext', liveLine(running, data.roster)), clock);
    box.appendChild(line);
  }

  if (now.progress) {
    const progress = el('div', 'ov__progress');
    const track = el('div', 'ov__track');
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', String(now.progress.total));
    track.setAttribute('aria-valuenow', String(now.progress.done));
    track.setAttribute('aria-label', 'Milestones done');
    const fill = el('div', 'ov__fill');
    fill.style.width = `${Math.round((now.progress.done / Math.max(1, now.progress.total)) * 100)}%`;
    track.appendChild(fill);
    progress.append(track, el('span', 'ov__count num', `${now.progress.done} of ${now.progress.total} milestones`));
    box.appendChild(progress);
  }

  if (now.briefing) box.appendChild(el('p', 'ov__briefing', now.briefing));

  const facts = el('dl', 'ov__facts');
  if (now.next) facts.append(el('dt', undefined, 'Next'), el('dd', undefined, now.next));
  for (const blocker of now.blockers) {
    const dd = el('dd', 'ov__blocker');
    dd.append(el('span', 'dot dot--needs'), document.createTextNode(blocker));
    facts.append(el('dt', undefined, 'Blocked'), dd);
  }
  if (facts.childElementCount) box.appendChild(facts);

  if (invite?.kind === 'turn') {
    const go = button(invite.action, 'btn btn--primary ov__nowaction');
    go.dataset.key = 'invite-turn';
    go.addEventListener('click', () => actions.invite('turn'));
    box.appendChild(go);
  }
  return box;
}

/** The team as faces: the manager, then everyone the manager hands work to, then Add. */
function teamNode(data: OverviewData, actions: OverviewActions): HTMLElement {
  const { project, state, roster } = data;
  const chatting = new Set(
    [...state.projectBusy]
      .filter((key) => key.startsWith(`${project.slug}:`))
      .map((key) => key.slice(project.slug.length + 1)),
  );
  const running = runningTurn(turnsOf(state, project.slug).turns);
  if (running) for (const who of ['manager', ...openSubagents(running)]) chatting.add(who);

  const tiers = orgChartModel(roster, chatting);
  const cards = tiers.flatMap((tier) => tier.cards);
  const people = cards.filter((card) => card.kind === 'manager' || card.kind === 'employee');
  const above = cards.filter((card) => card.kind === 'assistant' || card.kind === 'master');

  const row = el('div', 'team');
  for (const card of people) {
    const face = button('', 'member');
    face.dataset.key = `member-${card.id}`;
    face.dataset.who = card.id;
    const tile = el('span', 'member__tile');
    if (card.avatar) tile.appendChild(avatarSvg(card.avatar, 36));
    const status = card.status ?? 'idle';
    const dot = el('span', `dot member__dot dot--${status === 'working' ? 'working dot--pulse' : 'idle'}`);
    tile.appendChild(dot);
    face.appendChild(tile);
    face.append(el('span', 'member__name', card.name), el('span', 'member__role', card.kind === 'manager' ? 'Plans each turn' : card.role));
    const doing = doingCaption(running, card.id, 40);
    const doingLine = el('span', 'member__doing', doing ?? '');
    doingLine.hidden = !doing;
    face.appendChild(doingLine);
    face.title = `${card.name} — ${status === 'working' ? 'working' : 'idle'}. Open their panel.`;
    face.addEventListener('click', () => actions.openCard(card));
    row.appendChild(face);
  }
  if (data.rosterState === 'failed') row.appendChild(el('p', 'empty empty--error', 'The hub did not answer for this team.'));

  const add = button('', 'member member--add');
  add.dataset.key = 'member-add';
  const addTile = el('span', 'member__tile');
  addTile.appendChild(icon('plus', 20));
  add.append(addTile, el('span', 'member__name', 'Add'), el('span', 'member__role', 'employee'));
  add.title = 'Add an employee';
  add.addEventListener('click', actions.addEmployee);
  row.appendChild(add);

  const wrap = el('div');
  wrap.appendChild(row);
  if (above.length) {
    const also = el('p', 'ov__also');
    also.appendChild(el('span', undefined, 'Above the team'));
    for (const card of above) {
      const link = button('', 'ov__alsolink');
      link.dataset.key = `member-${card.id}`;
      if (card.avatar) link.appendChild(avatarSvg(card.avatar, 16));
      link.append(document.createTextNode(card.kind === 'assistant' ? 'Your assistant' : 'Master — all briefings'));
      link.addEventListener('click', () => actions.openCard(card));
      also.appendChild(link);
    }
    wrap.appendChild(also);
  }
  return wrap;
}

/** The last three turns, each a line that opens the Activity tab. */
function activityNode(data: OverviewData, actions: OverviewActions): HTMLElement {
  const held = turnsOf(data.state, data.project.slug);
  const list = el('div', 'ov__list');
  const turns = recentTurns(held.turns);
  if (!turns.length) {
    list.appendChild(el('p', held.state === 'failed' ? 'empty empty--error' : 'empty', held.state === 'loading'
      ? 'Loading…'
      : held.state === 'failed' ? 'The hub did not answer for this project’s turns.' : 'Nothing yet — the first turn will show up here.'));
    return list;
  }
  for (const turn of turns) {
    const tone = turnTone(turn);
    const line = button('', 'ov__turn');
    line.dataset.key = `turn-${turn.sessionId}`;
    const dot = el('span', `dot ${tone === 'running' ? 'dot--working dot--pulse' : tone === 'failed' ? 'dot--error' : 'dot--idle'}`);
    const text = tone === 'running'
      ? liveLine(turn, data.roster)
      : (turn.summary ? truncate(turn.summary, 140) : (turn.outcome ?? 'Ended'));
    const meta = el('span', 'ov__turnmeta num');
    const dur = el('span', undefined, formatElapsed(turnDuration(turn, Date.now())));
    if (tone === 'running') dur.dataset.elapsed = String(turn.startedAt);
    meta.appendChild(dur);
    if (turn.cost.usd > 0) meta.append(document.createTextNode(' · '), el('span', undefined, formatUsd(turn.cost.usd)));
    line.append(dot, el('span', 'ov__turntime num', formatTime(turn.startedAt)), el('span', 'ov__turntext', text), meta);
    line.addEventListener('click', () => actions.openTab('activity'));
    list.appendChild(line);
  }
  return list;
}

/** "In this project": one line per part, its state on the right, a chevron to go there. */
function glanceNode(data: OverviewData, actions: OverviewActions): HTMLElement {
  const list = el('div', 'glance');
  for (const item of GLANCE) {
    const summary = item.summary(data);
    const line = button('', `glance__row${summary.filled ? '' : ' glance__row--empty'}`);
    line.dataset.key = `glance-${summary.id}`;
    const label = el('span', 'glance__label', summary.id === 'prd' ? 'Requirements' : summary.label);
    const value = el('span', 'glance__value', summary.badge ? `${summary.badge} · ${summary.hint}` : summary.hint);
    line.append(icon(item.icon, 16), label, value, icon('chevronRight', 14));
    line.addEventListener('click', () => actions.openTab(item.tab, item.part));
    list.appendChild(line);
  }
  return list;
}

export function renderOverview(host: HTMLElement, data: OverviewData, actions: OverviewActions): void {
  // Keyboard focus survives the redraw: the element with the same key gets it back.
  const active = document.activeElement instanceof HTMLElement && host.contains(document.activeElement)
    ? document.activeElement.dataset.key ?? null
    : null;

  const root = el('div', 'overview');

  const intro = el('div', 'ov__intro');
  if (data.project.intent.trim()) intro.appendChild(el('p', 'ov__intent', data.project.intent));
  const source = projectSourceRow(data.project);
  if (source) intro.appendChild(source);
  if (intro.childElementCount) root.appendChild(intro);

  const held = turnsOf(data.state, data.project.slug);
  const invite = overviewInvite(
    data.prd.state === 'ready' ? !!data.prd.doc?.drafted : data.prd.state === 'failed' ? true : null,
    data.roadmap.state === 'ready' ? (data.roadmap.doc?.milestones?.length ?? 0) : data.roadmap.state === 'failed' ? 1 : null,
    held.state === 'ready' ? held.turns.length : held.state === 'failed' ? 1 : null,
  );

  // A running turn leads, whatever is still missing; otherwise the invitation does, and the Now
  // block carries "Run the first turn" itself.
  const now = nowNode(data, invite, actions);
  const running = !!runningTurn(held.turns);
  if (running && now) root.appendChild(now);
  if (invite && invite.kind !== 'turn') root.appendChild(inviteNode(invite, actions));
  else if (now && !running) root.appendChild(now);
  else if (invite && !now) root.appendChild(inviteNode(invite, actions));

  const team = section('Team');
  team.body.appendChild(teamNode(data, actions));
  root.appendChild(team.root);

  const seeAll = button('See all', 'btn btn--plain btn--small');
  seeAll.dataset.key = 'see-all';
  seeAll.addEventListener('click', () => actions.openTab('activity'));
  const activity = section('Recent activity', held.turns.length ? seeAll : undefined);
  activity.body.appendChild(activityNode(data, actions));
  root.appendChild(activity.root);

  const glance = section('In this project');
  glance.body.appendChild(glanceNode(data, actions));
  if (data.cost) glance.body.appendChild(el('p', 'ov__cost num', `Spent ${data.cost}`));
  root.appendChild(glance.root);

  host.replaceChildren(root);
  if (active) host.querySelector<HTMLElement>(`[data-key="${CSS.escape(active)}"]`)?.focus();
}

/** The running clocks, once a second, without a redraw. */
export function tickOverview(host: HTMLElement): void {
  const now = Date.now();
  for (const node of host.querySelectorAll<HTMLElement>('[data-elapsed]')) {
    node.textContent = formatElapsed(now - Number(node.dataset.elapsed));
  }
}
