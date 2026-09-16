/**
 * The tab strip inside a selected project. Pure — the DOM lives in `pages/projects.ts`.
 *
 * Which tab a project was last left on is remembered for the session, per project, so stepping
 * through the list with ←/→ doesn't yank a reader back to the org chart every time.
 */

export type TabId = 'team' | 'prd' | 'roadmap' | 'docs';

export interface ProjectTab {
  id: TabId;
  label: string;
}

/** Left to right, and the order ←/→ walks. */
export const PROJECT_TABS: readonly ProjectTab[] = [
  { id: 'team', label: 'Team' },
  { id: 'prd', label: 'PRD' },
  { id: 'roadmap', label: 'Roadmap' },
  { id: 'docs', label: 'Docs' },
];

export const DEFAULT_TAB: TabId = 'team';

export interface TabEntry extends ProjectTab {
  current: boolean;
}

/** Every tab, with the one being shown marked. */
export function tabModel(active: TabId): TabEntry[] {
  return PROJECT_TABS.map((tab) => ({ ...tab, current: tab.id === active }));
}

/** Where ←/→ land from `active`; the strip wraps, the way a tablist is expected to. */
export function stepTab(active: TabId, step: 1 | -1): TabId {
  const at = PROJECT_TABS.findIndex((tab) => tab.id === active);
  const from = at < 0 ? 0 : at;
  return PROJECT_TABS[(from + step + PROJECT_TABS.length) % PROJECT_TABS.length].id;
}

/** The tab a project should open on: whatever it was last left on, else Team. */
export function activeTab(memory: Readonly<Record<string, TabId>>, slug: string | null): TabId {
  if (!slug) return DEFAULT_TAB;
  const remembered = memory[slug];
  return PROJECT_TABS.some((tab) => tab.id === remembered) ? remembered : DEFAULT_TAB;
}

/** The memory with `slug` moved to `tab`; the input is left alone. */
export function rememberTab(
  memory: Readonly<Record<string, TabId>>, slug: string, tab: TabId,
): Record<string, TabId> {
  return { ...memory, [slug]: tab };
}
