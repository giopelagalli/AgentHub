import type { ModelPolicy, TeamRoster, TeamStatus } from '@agenthub/shared';

/** What a card is, which decides what clicking it opens. */
export type OrgKind = 'owner' | 'assistant' | 'master' | 'manager' | 'employee';

export interface OrgCard {
  /** `who` for the chat routes on manager and employee cards; a fixed word on the others. */
  id: string;
  kind: OrgKind;
  name: string;
  role: string;
  /** The card above this one in words, null for the owner. */
  reportsTo: string | null;
  /** An `AVATARS` id, or null for the owner — the owner is a person, not a unit. */
  avatar: string | null;
  /** null where the hub reports no working/idle state for this card. */
  status: TeamStatus | null;
  /** An employee's per-member model override, when they have one — absent on every other card. */
  model?: ModelPolicy;
}

export interface OrgTier {
  label: string;
  cards: OrgCard[];
}

/** The assistant and the master are the same two on every project, so their look is fixed here. */
const ASSISTANT: OrgCard = {
  id: 'assistant', kind: 'assistant', name: 'Assistant', role: 'Personal assistant',
  reportsTo: 'You', avatar: 'robot-cyan', status: null,
};
const MASTER: OrgCard = {
  id: 'master', kind: 'master', name: 'Master', role: 'Master orchestrator',
  reportsTo: 'You', avatar: 'robot-magenta', status: null,
};

/**
 * The hierarchy behind the org chart: you, then the two global agents, then this
 * project's manager, then its employees. `chatting` holds `slug:who` keys of
 * agents mid-reply, which count as working alongside whatever the roster says.
 */
export function orgChartModel(
  roster: TeamRoster | null,
  chatting: ReadonlySet<string> = new Set(),
): OrgTier[] {
  const working = (who: string, status: TeamStatus | undefined): TeamStatus =>
    chatting.has(who) || status === 'working' ? 'working' : 'idle';

  const manager: OrgCard = {
    id: 'manager',
    kind: 'manager',
    name: 'Manager',
    role: 'Project orchestrator',
    reportsTo: 'Master',
    avatar: 'robot-amber',
    status: roster ? working('manager', roster.manager.status) : null,
  };

  const employees: OrgCard[] = (roster?.members ?? []).map((member) => ({
    id: member.id,
    kind: 'employee',
    name: member.name,
    role: member.role,
    reportsTo: 'Manager',
    avatar: member.avatar,
    status: working(member.id, member.status),
    ...(member.model ? { model: member.model } : {}),
  }));

  return [
    { label: 'Owner', cards: [{ id: 'owner', kind: 'owner', name: 'You', role: 'Owner', reportsTo: null, avatar: null, status: null }] },
    { label: 'Global', cards: [ASSISTANT, MASTER] },
    { label: 'Project', cards: [manager] },
    { label: 'Employees', cards: employees },
  ];
}
