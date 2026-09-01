// ============================================================
//  Layout — cubicle + board position persistence
//  Stores positions in data/layout.json
// ============================================================

const fs = require('fs');
const path = require('path');

const LAYOUT_PATH = path.join(__dirname, '..', 'data', 'layout.json');

const DEFAULTS = {
  cubicles: {},
  boards: {
    tasks:    { col: 1, row: 0 },
    research: { col: 2, row: 0 },
    projects: { col: 3, row: 0 },
  },
};

function load() {
  try {
    if (fs.existsSync(LAYOUT_PATH)) {
      return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(LAYOUT_PATH, 'utf8')) };
    }
  } catch (err) {
    console.error('[Layout] Failed to load:', err.message);
  }
  return { ...DEFAULTS };
}

function save(layout) {
  try {
    fs.mkdirSync(path.dirname(LAYOUT_PATH), { recursive: true });
    fs.writeFileSync(LAYOUT_PATH, JSON.stringify(layout, null, 2), 'utf8');
  } catch (err) {
    console.error('[Layout] Failed to save:', err.message);
  }
}

/** Get position for a cubicle (or null if not yet placed) */
function getCubiclePos(name) {
  const layout = load();
  return layout.cubicles[name] || null;
}

/** Set cubicle position */
function setCubiclePos(name, col, row) {
  const layout = load();
  layout.cubicles[name] = { col, row };
  save(layout);
}

/** Auto-assign a position for a new agent */
function autoAssign(name, existingNames) {
  const layout = load();

  // Already placed
  if (layout.cubicles[name]) return layout.cubicles[name];

  // Find the next free grid cell
  const occupied = new Set();
  for (const n of existingNames) {
    const pos = layout.cubicles[n];
    if (pos) occupied.add(`${pos.col},${pos.row}`);
  }

  // Board row is row 0, cubicles start at row 1
  for (let row = 1; row < 20; row++) {
    for (let col = 0; col < 6; col++) {
      if (!occupied.has(`${col},${row}`)) {
        layout.cubicles[name] = { col, row };
        save(layout);
        return { col, row };
      }
    }
  }

  // Fallback
  layout.cubicles[name] = { col: 0, row: 1 };
  save(layout);
  return { col: 0, row: 1 };
}

/** Bulk update positions (for edit mode save) */
function bulkUpdate(cubiclePositions) {
  const layout = load();
  layout.cubicles = { ...layout.cubicles, ...cubiclePositions };
  save(layout);
}

/** Remove a cubicle position */
function removeCubicle(name) {
  const layout = load();
  delete layout.cubicles[name];
  save(layout);
}

/**
 * Compute auto-layout based on team structure.
 * Row 0: boards (handled by frontend)
 * Row 1: CEO (director tier, centered)
 * Row 2: Research team members (sorted by tier: manager→senior→junior)
 * Row 3: Production team members (sorted by tier)
 * Row 4+: Unassigned agents
 *
 * @param {Array} agents - [{name, tier}]
 * @param {Array} teams - [{id, name, type}]
 * @param {Object} teamMembers - {teamId: [{agent_name}]}
 */
function computeAutoLayout(agents, teams, teamMembers) {
  const layoutData = load();
  const tierRank = { director: 0, manager: 1, senior: 2, junior: 3 };

  // Categorize agents
  const director = agents.find(a => a.tier === 'director');
  const researchTeam = teams.find(t => t.type === 'research');
  const productionTeam = teams.find(t => t.type === 'production');

  const researchMembers = researchTeam && teamMembers[researchTeam.id]
    ? teamMembers[researchTeam.id].map(m => m.agent_name) : [];
  const productionMembers = productionTeam && teamMembers[productionTeam.id]
    ? teamMembers[productionTeam.id].map(m => m.agent_name) : [];

  const assigned = new Set([
    ...(director ? [director.name] : []),
    ...researchMembers,
    ...productionMembers,
  ]);
  const unassigned = agents.filter(a => !assigned.has(a.name));

  // Sort by tier rank
  const sortByTier = (names) => {
    return [...names].sort((a, b) => {
      const agA = agents.find(x => x.name === a);
      const agB = agents.find(x => x.name === b);
      return (tierRank[agA?.tier] || 3) - (tierRank[agB?.tier] || 3);
    });
  };

  const cubicles = {};

  // Row 1: Director (centered, col 2)
  if (director) {
    cubicles[director.name] = { col: 2, row: 1 };
  }

  // Row 2: Research team
  const sortedResearch = sortByTier(researchMembers);
  for (let i = 0; i < sortedResearch.length; i++) {
    cubicles[sortedResearch[i]] = { col: i % 6, row: 2 };
  }

  // Row 3: Production team
  const sortedProd = sortByTier(productionMembers);
  for (let i = 0; i < sortedProd.length; i++) {
    cubicles[sortedProd[i]] = { col: i % 6, row: 3 };
  }

  // Row 4+: Unassigned
  const sortedUnassigned = unassigned.sort((a, b) =>
    (tierRank[a.tier] || 3) - (tierRank[b.tier] || 3)
  );
  let uRow = 4, uCol = 0;
  for (const agent of sortedUnassigned) {
    if (cubicles[agent.name]) continue; // skip if already placed (director)
    cubicles[agent.name] = { col: uCol, row: uRow };
    uCol++;
    if (uCol >= 6) { uCol = 0; uRow++; }
  }

  layoutData.cubicles = cubicles;
  save(layoutData);
  return cubicles;
}

/** Get full layout for frontend */
function getAll() {
  const layout = load();
  return {
    cubicles: layout.cubicles,
    boards: layout.boards || DEFAULTS.boards,
  };
}

module.exports = {
  load, save, getCubiclePos, setCubiclePos,
  autoAssign, bulkUpdate, removeCubicle, computeAutoLayout, getAll,
};
