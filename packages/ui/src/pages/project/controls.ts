import { PRIORITY_RANK, type ModelCatalog, type ModelPolicy, type Priority, type TeamMemberView } from '@agenthub/shared';
import { sendJson } from '../../api.js';
import { el } from '../../dom.js';
import { memberModelOptions, modelOptions, policyFromValue, policyPillText, valueFromPolicy, workerOptions, SAME_AS_ORCHESTRATOR } from '../../models.js';
import { toast } from '../../toast.js';
import { segmented } from '../../toolbar.js';

/**
 * The levers a project has — its priority and its models — as controls that post themselves. The
 * settings sheet lays them out; the Machines queue reuses the priority picker on every row.
 */

export const PRIORITIES = Object.keys(PRIORITY_RANK) as Priority[];

/** Human words for the hub's queue classes (`Priority`/`PRIORITY_RANK`) — which project's turns and jobs go first when machines are busy. */
export const PRIORITY_LABELS: Record<Priority, string> = { interactive: 'Runs first', project: 'Normal', batch: 'When idle' };

export function priorityLabel(p: Priority): string {
  return PRIORITY_LABELS[p];
}

const postPriority = (slug: string, wanted: Priority, revert: () => void): void => {
  void sendJson(`/api/projects/${slug}/priority`, { priority: wanted })
    .then(() => toast(`${slug} now ${wanted === 'project' ? 'runs at normal priority' : PRIORITY_LABELS[wanted].toLowerCase()}.`))
    .catch((error: unknown) => {
      toast(`Could not set the priority: ${String(error)}`, 'error');
      revert();
    });
};

/** The priority as a compact `<select>`, for a table row. */
export function priorityPicker(slug: string, value: Priority): HTMLSelectElement {
  const box = el('select', 'select');
  for (const option of PRIORITIES) {
    const item = el('option', undefined, PRIORITY_LABELS[option]);
    item.value = option;
    box.appendChild(item);
  }
  box.value = value;
  box.title = 'Priority — which project gets the machines first when they are busy';
  box.setAttribute('aria-label', `Priority of ${slug}`);
  box.addEventListener('change', () => postPriority(slug, box.value as Priority, () => { box.value = value; }));
  return box;
}

/** The priority as a segmented control, for the settings sheet. */
export function prioritySegments(slug: string, value: Priority): HTMLElement {
  let current = value;
  const control = segmented(
    PRIORITIES.map((id) => ({ id, label: PRIORITY_LABELS[id] })),
    value,
    (id) => {
      const before = current;
      current = id;
      postPriority(slug, id, () => { current = before; control.set(before); });
    },
    'Priority',
  );
  return control.root;
}

function fillSelect(select: HTMLSelectElement, options: { value: string; label: string; disabled?: boolean }[]): void {
  for (const option of options) {
    const item = el('option', undefined, option.label);
    item.value = option.value;
    if (option.disabled) item.disabled = true;
    select.appendChild(item);
  }
}

export interface ModelPickers {
  /** Everything `/api/models` lists. */
  main: HTMLSelectElement;
  /** Once a cloud provider is chosen: a cheaper model for the worker tier; null otherwise. */
  worker: HTMLSelectElement | null;
}

/**
 * The project's model policy: one `<select>` over everything `/api/models` lists, plus — once a
 * cloud provider is chosen — a second one that can give the worker tier a cheaper model. Both post
 * the whole policy, so the hub never has to merge a partial one.
 *
 * `currentPolicy` reads the manifest's *current* policy at post time (defaulting to the `policy`
 * these were rendered with) — the worker select's change handler uses it instead of closing over
 * the render-time `policy`, so a policy change made between render and that click (e.g. the main
 * select's own post still in flight) isn't clobbered by a stale orchestrator model.
 */
export function modelPickers(
  slug: string,
  policy: ModelPolicy | undefined,
  catalog: ModelCatalog | null,
  currentPolicy: () => ModelPolicy | undefined = () => policy,
): ModelPickers {
  const post = (next: ModelPolicy, revert: () => void): void => {
    void sendJson(`/api/projects/${slug}/model`, next)
      .then(() => toast(`${slug} now runs on ${policyPillText(next)}.`))
      .catch((error: unknown) => {
        toast(`Could not set models: ${String(error)}`, 'error');
        revert();
      });
  };

  const main = el('select', 'select');
  const options = modelOptions(catalog);
  fillSelect(main, options);
  const current = valueFromPolicy(policy);
  // The catalog can fail to load (or not include this policy's model any more) while the manifest
  // still names it — without this, `main.value = current` finds no matching option and the select
  // renders blank instead of showing what the project is actually on.
  if (!options.some((o) => o.value === current)) {
    const missing = el('option', undefined, policyPillText(policy));
    missing.value = current;
    missing.disabled = true;
    main.appendChild(missing);
  }
  main.value = current;
  main.setAttribute('aria-label', 'Model');
  main.addEventListener('change', () => post(policyFromValue(main.value), () => { main.value = current; }));

  const provider = policy?.prefer === 'cloud' ? policy.provider : undefined;
  if (!provider) return { main, worker: null };

  const worker = el('select', 'select');
  fillSelect(worker, workerOptions(catalog, provider));
  const workerCurrent = policy?.workerModel && policy.workerModel !== policy.orchestratorModel
    ? policy.workerModel
    : SAME_AS_ORCHESTRATOR;
  worker.value = workerCurrent;
  worker.setAttribute('aria-label', 'Worker model');
  worker.addEventListener('change', () => {
    const live = currentPolicy();
    post({
      prefer: 'cloud', provider,
      ...(live?.orchestratorModel ? { orchestratorModel: live.orchestratorModel } : {}),
      ...(worker.value ? { workerModel: worker.value } : live?.orchestratorModel ? { workerModel: live.orchestratorModel } : {}),
    }, () => { worker.value = workerCurrent; });
  });
  return { main, worker };
}

/**
 * An employee's model override, shown in their drawer: "Project default" plus everything the
 * project's own picker offers, posted to their roster entry (`PATCH .../team/:id`) rather than the
 * project's. `null` on change clears it back to the project default.
 */
export function memberModelField(slug: string, member: TeamMemberView, catalog: ModelCatalog | null): HTMLElement {
  const field = el('label', 'drawer__field');
  field.append(el('span', 'drawer__fieldlabel', 'Model'));
  const select = el('select', 'select');
  fillSelect(select, memberModelOptions(catalog));
  const current = member.model ? valueFromPolicy(member.model) : '';
  select.value = current;
  select.addEventListener('change', () => {
    const next = select.value ? policyFromValue(select.value) : null;
    void sendJson(`/api/projects/${slug}/team/${member.id}`, { model: next }, 'PATCH')
      .then(() => toast(`${member.name} now runs on ${next ? policyPillText(next) : 'the project default'}.`))
      .catch((error: unknown) => {
        toast(`Could not set ${member.name}'s model: ${String(error)}`, 'error');
        select.value = current;
      });
  });
  field.appendChild(select);
  return field;
}
