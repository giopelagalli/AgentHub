import { AVATARS, TEAM_ROLES, type HarnessInfo, type ModelCatalog, type ModelPolicy, type ProjectManifest, type TeamRoster, type TurnBudget } from '@agenthub/shared';
import { sendJson } from '../../api.js';
import { AUTO_RUN_INTERVALS, autoRunFromForm, budgetSentence, intervalWords, scheduleSentence } from '../../autorun.js';
import { avatarSvg } from '../../avatars.js';
import { button, el } from '../../dom.js';
import { icon } from '../../icons.js';
import { openModal } from '../../panels/modal.js';
import { toast } from '../../toast.js';
import { modelPickers, prioritySegments, projectHarnessPicker } from './controls.js';

/**
 * The project's settings, as a sheet grouped the way macOS Settings groups things: Models,
 * Schedule, Priority, Team, Pause. Everything the old header carried as controls lives here now,
 * and every control applies as it changes — there is no Save.
 */

export type SettingsSection = 'models' | 'schedule' | 'priority' | 'team' | 'pause';

export interface SettingsOptions {
  /** The manifest as the hub last pushed it, read fresh whenever a section is drawn. */
  project: () => ProjectManifest | null;
  catalog: () => ModelCatalog | null;
  /** What `GET /api/harnesses` said this host can run; empty until it answers. */
  harnesses: () => HarnessInfo[];
  roster: () => TeamRoster | null;
  budget: () => TurnBudget | undefined;
  /** "$0.42 today", or empty while unknown. */
  cost: () => string;
  /** The team changed (a hire, a removal): the page re-reads the roster. */
  onTeamChanged: () => Promise<void>;
  /** The schedule changed: the page re-reads the turn budget. */
  onScheduleChanged: () => void;
  /** Scroll to and open a section first, e.g. Team from the Overview's add button. */
  section?: SettingsSection;
  /** The sheet has gone, whichever way it was closed. */
  onClose?: () => void;
}

export interface SettingsHandle {
  close(): void;
  /** The manifest moved (the hub pushed a new one): redraw what depends on it. */
  refresh(): void;
}

/** One group: a heading, a box of rows, and a line of explanation under it. */
function group(title: string, foot?: string): { root: HTMLElement; box: HTMLElement; foot: HTMLElement } {
  const root = el('section', 'sgroup');
  const box = el('div', 'sgroup__box');
  const footNode = el('p', 'sgroup__foot', foot ?? '');
  footNode.hidden = !foot;
  root.append(el('h3', 'sgroup__title', title), box, footNode);
  return { root, box, foot: footNode };
}

/** One row: what it is on the left, the control on the right. */
function row(label: string, control?: HTMLElement | null, hint?: string): HTMLElement {
  const node = el('div', 'srow');
  const text = el('div', 'srow__text');
  text.appendChild(el('span', 'srow__label', label));
  if (hint) text.appendChild(el('span', 'srow__hint', hint));
  node.appendChild(text);
  if (control) {
    const slot = el('div', 'srow__control');
    slot.appendChild(control);
    node.appendChild(slot);
  }
  return node;
}

export function openProjectSettings(host: HTMLElement, options: SettingsOptions): SettingsHandle {
  const slug = options.project()?.slug ?? '';
  const modal = openModal(host, { className: 'settings', label: 'Project settings', ...(options.onClose ? { onClose: options.onClose } : {}) });

  const head = el('header', 'settings__head');
  const titles = el('div', 'settings__titles');
  const heading = el('h2', undefined, 'Settings');
  const sub = el('p', 'settings__sub', options.project()?.title ?? slug);
  titles.append(heading, sub);
  const done = button('Done', 'btn btn--primary');
  done.addEventListener('click', () => modal.close());
  head.append(titles, done);

  const body = el('div', 'settings__body');
  modal.box.append(head, body);

  // --- Models ---------------------------------------------------------------------------------

  const models = group('Models', 'Which models this project’s turns run on. An employee can be given their own in their panel.');
  let shownPolicy = '';
  const drawModels = (): void => {
    const project = options.project();
    if (!project) return;
    const key = JSON.stringify([project.modelPolicy ?? null, project.harness ?? null, options.harnesses()]);
    // Redrawn only when the policy, the harness or what this host can run moved — never under a select the owner has open.
    if (key === shownPolicy || models.box.contains(document.activeElement)) return;
    shownPolicy = key;
    const pickers = modelPickers(slug, project.modelPolicy, options.catalog(), (): ModelPolicy | undefined => options.project()?.modelPolicy);
    models.box.replaceChildren(row('Model', pickers.main, 'Runs the manager and, unless set below, everyone else'));
    if (pickers.worker) models.box.appendChild(row('Employees use', pickers.worker, 'A cheaper model for the work the manager hands out'));
    const harness = projectHarnessPicker(slug, project, options.harnesses());
    if (harness) {
      const harnessRow = row('Harness', harness.select, 'What employees work in, unless given their own');
      for (const reason of harness.reasons) harnessRow.querySelector('.srow__text')?.appendChild(el('span', 'srow__hint', reason));
      models.box.appendChild(harnessRow);
    }
  };

  // --- Schedule -------------------------------------------------------------------------------

  const schedule = group('Schedule');
  const enabled = el('input', 'switch');
  enabled.type = 'checkbox';
  enabled.setAttribute('aria-label', 'Run on its own');
  const every = el('select', 'select');
  every.setAttribute('aria-label', 'How often');
  for (const minutes of AUTO_RUN_INTERVALS) {
    const option = el('option', undefined, minutes === 60 ? '1 hour' : intervalWords(minutes));
    option.value = String(minutes);
    every.appendChild(option);
  }
  const cap = el('input', 'input settings__number');
  cap.type = 'number';
  cap.min = '1';
  cap.max = '100';
  cap.setAttribute('aria-label', 'Turns a day at most');
  const capWrap = el('div', 'settings__inline');
  capWrap.append(cap, el('span', undefined, 'turns'));
  const enabledRow = row('Run on its own', enabled);
  const everyRow = row('Every', every);
  const capRow = row('At most, a day', capWrap, 'The hub keeps its own cap across every project too');
  schedule.box.append(enabledRow, everyRow, capRow);

  const drawSchedule = (): void => {
    const auto = options.project()?.autoRun;
    if (!schedule.box.contains(document.activeElement)) {
      enabled.checked = auto?.enabled ?? false;
      every.value = String(auto?.everyMinutes ?? 60);
      cap.value = String(auto?.maxTurnsPerDay ?? 6);
    }
    everyRow.hidden = !enabled.checked;
    capRow.hidden = !enabled.checked;
    const budget = budgetSentence(options.budget());
    const cost = options.cost();
    schedule.foot.textContent = [scheduleSentence(auto && { ...auto, enabled: enabled.checked }), budget, cost ? `Spent ${cost}` : '']
      .filter(Boolean).join('. ') + '.';
    schedule.foot.hidden = false;
  };

  const saveSchedule = (): void => {
    const autoRun = autoRunFromForm({ enabled: enabled.checked, everyMinutes: every.value, maxTurnsPerDay: cap.value });
    if (!autoRun) {
      toast('Pick how often, and a daily cap from 1 to 100.', 'error');
      return;
    }
    void sendJson(`/api/projects/${slug}/autorun`, autoRun)
      .then(() => { options.onScheduleChanged(); })
      .catch((error: unknown) => toast(`Could not set the schedule: ${String(error)}`, 'error'));
  };
  enabled.addEventListener('change', () => {
    everyRow.hidden = !enabled.checked;
    capRow.hidden = !enabled.checked;
    saveSchedule();
  });
  every.addEventListener('change', saveSchedule);
  cap.addEventListener('change', saveSchedule);

  // --- Priority -------------------------------------------------------------------------------

  const priority = group(
    'Priority',
    'When the machines are busy, projects that run first get them first. The Master may reorder projects during its briefings; your choice holds until it does.',
  );
  let shownPriority = '';
  const drawPriority = (): void => {
    const project = options.project();
    if (!project || project.priority === shownPriority) return;
    shownPriority = project.priority;
    const wrap = el('div', 'srow srow--full');
    wrap.appendChild(prioritySegments(slug, project.priority));
    priority.box.replaceChildren(wrap);
  };

  // --- Team -----------------------------------------------------------------------------------

  const team = group('Team', 'The manager plans each turn and hands work to the employees. Each has a chat of their own on the Overview.');
  let hiring = options.section === 'team';

  const hireForm = (): HTMLFormElement => {
    const form = el('form', 'hire');
    const name = el('input', 'input');
    name.placeholder = 'Name';
    name.required = true;
    name.setAttribute('aria-label', 'Name');
    const role = el('select', 'select');
    role.setAttribute('aria-label', 'Role');
    for (const value of TEAM_ROLES) {
      const option = el('option', undefined, value.charAt(0).toUpperCase() + value.slice(1));
      option.value = value;
      role.appendChild(option);
    }
    const top = el('div', 'hire__row');
    top.append(name, role);

    const picker = el('div', 'hire__avatars');
    picker.setAttribute('role', 'radiogroup');
    picker.setAttribute('aria-label', 'Avatar');
    let chosen: string = AVATARS[0];
    const choices = AVATARS.map((id) => {
      const choice = button('', 'hire__avatar');
      choice.title = id;
      choice.setAttribute('role', 'radio');
      choice.appendChild(avatarSvg(id, 28));
      choice.addEventListener('click', () => {
        chosen = id;
        for (const other of choices) other.setAttribute('aria-checked', 'false');
        choice.setAttribute('aria-checked', 'true');
      });
      picker.appendChild(choice);
      return choice;
    });
    for (const [index, choice] of choices.entries()) choice.setAttribute('aria-checked', String(index === 0));

    const instructions = el('textarea', 'input hire__instructions');
    instructions.placeholder = 'Standing instructions (optional)';
    instructions.rows = 3;

    const cancel = button('Cancel');
    cancel.addEventListener('click', () => { hiring = false; drawTeam(); });
    const submit = el('button', 'btn btn--primary', 'Hire');
    submit.type = 'submit';
    const actions = el('div', 'actions hire__actions');
    actions.append(cancel, submit);

    form.append(top, picker, instructions, actions);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const hired = name.value.trim();
      if (!hired) { name.focus(); return; }
      submit.disabled = true;
      void sendJson(`/api/projects/${slug}/team`, {
        name: hired,
        role: role.value,
        avatar: chosen,
        ...(instructions.value.trim() ? { instructions: instructions.value.trim() } : {}),
      })
        .then(async () => {
          toast(`${hired} joined the team.`);
          hiring = false;
          await options.onTeamChanged();
          drawTeam();
        })
        .catch((error: unknown) => toast(`Could not hire: ${String(error)}`, 'error'))
        .finally(() => { submit.disabled = false; });
    });
    queueMicrotask(() => name.focus());
    return form;
  };

  const drawTeam = (): void => {
    const roster = options.roster();
    team.box.replaceChildren();
    const manager = el('div', 'srow');
    const managerFace = el('span', 'srow__face');
    managerFace.appendChild(avatarSvg('robot-amber', 24));
    const managerText = el('div', 'srow__text');
    managerText.append(el('span', 'srow__label', 'Manager'), el('span', 'srow__hint', 'Plans each turn'));
    manager.append(managerFace, managerText);
    team.box.appendChild(manager);

    for (const member of roster?.members ?? []) {
      const line = el('div', 'srow');
      const face = el('span', 'srow__face');
      face.appendChild(avatarSvg(member.avatar, 24));
      const text = el('div', 'srow__text');
      text.append(el('span', 'srow__label', member.name), el('span', 'srow__hint', member.role));
      const remove = button('', 'btn btn--icon srow__remove');
      remove.appendChild(icon('trash', 16));
      remove.title = `Remove ${member.name}`;
      remove.setAttribute('aria-label', `Remove ${member.name}`);
      remove.addEventListener('click', () => {
        if (!confirm(`Remove ${member.name} from the team?`)) return;
        remove.disabled = true;
        void sendJson(`/api/projects/${slug}/team/${member.id}`, undefined, 'DELETE')
          .then(async () => {
            toast(`${member.name} removed.`);
            await options.onTeamChanged();
            drawTeam();
          })
          .catch((error: unknown) => {
            remove.disabled = false;
            toast(`Could not remove: ${String(error)}`, 'error');
          });
      });
      line.append(face, text, remove);
      team.box.appendChild(line);
    }

    if (hiring) {
      const wrap = el('div', 'srow srow--full');
      wrap.appendChild(hireForm());
      team.box.appendChild(wrap);
      return;
    }
    const add = button('', 'srow srow--action');
    add.append(icon('personAdd', 18), el('span', undefined, 'Add employee…'));
    add.addEventListener('click', () => { hiring = true; drawTeam(); });
    team.box.appendChild(add);
  };

  // --- Pause ----------------------------------------------------------------------------------

  const pause = group('Pause', 'A paused project runs no turns, scheduled or started by hand, until you resume it.');
  const drawPause = (): void => {
    const project = options.project();
    if (!project) return;
    const paused = project.status === 'paused';
    const toggle = button(paused ? 'Resume' : 'Pause', paused ? 'btn btn--primary' : 'btn');
    toggle.addEventListener('click', () => {
      toggle.disabled = true;
      void sendJson(`/api/projects/${slug}/${paused ? 'resume' : 'pause'}`)
        .then(() => toast(`${project.title} ${paused ? 'resumed' : 'paused'}.`))
        .catch((error: unknown) => {
          toggle.disabled = false;
          toast(`Could not ${paused ? 'resume' : 'pause'}: ${String(error)}`, 'error');
        });
    });
    pause.box.replaceChildren(row(paused ? 'This project is paused' : 'Pause this project', toggle));
  };

  body.append(models.root, schedule.root, priority.root, team.root, pause.root);

  const refresh = (): void => {
    const project = options.project();
    if (!project) { modal.close(); return; }
    sub.textContent = project.title;
    drawModels();
    drawSchedule();
    drawPriority();
    drawPause();
  };

  refresh();
  drawTeam();
  if (options.section) {
    const target = { models, schedule, priority, team, pause }[options.section];
    queueMicrotask(() => target.root.scrollIntoView({ block: 'start' }));
  } else {
    queueMicrotask(() => done.focus());
  }

  return { close: modal.close, refresh };
}
