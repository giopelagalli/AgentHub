// ============================================================
//  Office — canvas renderer with team enclosures, CEO board,
//  dynamic layout, animation state machine
// ============================================================

const Office = (() => {
  const S = Sprites.S;
  const CW = Sprites.CUB_W;
  const CH = Sprites.CUB_H;
  const BW = Sprites.BOARD_W;
  const BH = Sprites.BOARD_H;
  const GRID_PAD = 14;
  const WALK_SPEED = 7;
  const PHASE_TICKS = 1;

  // ── Animation state constants ─────────────────────────────
  const ANIM = {
    SEATED:       'seated',
    GETTING_UP:   'getting_up',
    WALKING:      'walking',
    AT_LOCATION:  'at_location',
    SITTING_DOWN: 'sitting_down',
  };

  let canvas, ctx;
  let agents = [];
  let frame = 0;
  let animInterval = null;

  // Layout positions
  let cubiclePositions = {};   // name → {x, y} in pixel-art coords
  let ceoBoardPos = null;      // {x, y} - single CEO directives board
  let addBtnPos = null;

  // Team enclosure data
  let teamSections = [];       // [{teamId, label, type, color, description, agents}]
  let enclosureData = [];      // [{teamId, label, type, color, description, x, y, w, h}]

  // Agent animation states
  let agentAnims = {};

  // Interaction
  let hoverTarget = null;
  let cubicleRects = [];
  let ceoBoardRect = null;
  let enclosureRects = [];     // [{teamId, x, y, w, h}]
  let addBtnRect = null;
  let createTeamBtnPos = null;
  let createTeamBtnRect = null;

  // Task / meeting state
  let ceoTodoCount = 0;
  let meetingNoteCount = 0;
  let teamHighlights = {};

  // ══════════════════════════════════════════════════════════
  //  INIT
  // ══════════════════════════════════════════════════════════

  function init(canvasEl) {
    canvas = canvasEl;
    ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('click', onClick);
    canvas.addEventListener('mouseleave', () => {
      hoverTarget = null;
    });

    animInterval = setInterval(() => {
      frame++;
      updateAnimations();
      render();
    }, 75);
  }

  // ══════════════════════════════════════════════════════════
  //  STATE UPDATE
  // ══════════════════════════════════════════════════════════

  function update(state) {
    agents = state.agents || [];

    // Apply team highlights if present
    if (state.teamHighlights) {
      teamHighlights = state.teamHighlights;
    }

    // Compute the dynamic layout
    computeDynamicLayout();

    // Init animation state for new agents
    for (const agent of agents) {
      if (!agentAnims[agent.name]) {
        const homePos = cubiclePositions[agent.name] || { x: 20, y: 60 };
        agentAnims[agent.name] = createAnimState(homePos);
      } else {
        const homePos = cubiclePositions[agent.name];
        if (homePos) {
          agentAnims[agent.name].homeCubPos = { ...homePos };
          if (agentAnims[agent.name].animState === ANIM.SEATED) {
            agentAnims[agent.name].walkPos = exitPos(homePos);
          }
        }
      }
    }

    resize();
    render();
  }

  function createAnimState(cubPos) {
    return {
      animState: ANIM.SEATED,
      animPhase: 0,
      animTimer: 0,
      walkPos: exitPos(cubPos),
      walkTarget: null,
      walkDirection: 'down',
      walkFrame: 0,
      homeCubPos: { ...cubPos },
      destination: null,
      bubble: null,
      pendingCommand: null,
    };
  }

  function exitPos(cubPos) {
    return { x: cubPos.x + CW / 2 - 5, y: cubPos.y + CH - 6 };
  }

  // ══════════════════════════════════════════════════════════
  //  DYNAMIC LAYOUT (team enclosures)
  // ══════════════════════════════════════════════════════════

  function computeDynamicLayout() {
    const positions = {};
    enclosureData = [];
    let currentY = 8;

    // ── Row 0: CEO Directives board (centered) ──────────────
    ceoBoardPos = { x: 20 + (CW + GRID_PAD), y: currentY };
    currentY += BH + 16;

    // ── CEO cubicle (standalone, centered) ──────────────────
    const ceoAgent = agents.find(a => a.tier === 'director');
    if (ceoAgent) {
      positions[ceoAgent.name] = { x: 20 + (CW + GRID_PAD), y: currentY };
      currentY += CH + 26;
    }

    // ── Team enclosures ─────────────────────────────────────
    const assignedAgents = new Set();
    if (ceoAgent) assignedAgents.add(ceoAgent.name);

    for (const sec of teamSections) {
      const numAgents = (sec.agents || []).length;
      const { w: enclW, h: enclH } = Sprites.getEnclosureSize(numAgents);

      const encl = {
        teamId: sec.teamId,
        label: sec.label || sec.teamName || '',
        type: sec.type || 'research',
        color: sec.color || '#53d8fb',
        description: sec.description || '',
        x: 20,
        y: currentY,
        w: enclW,
        h: enclH,
        agents: sec.agents,
      };
      enclosureData.push(encl);

      // Position cubicles inside enclosure
      for (let i = 0; i < sec.agents.length; i++) {
        const cubPos = Sprites.getEnclosureCubPos(encl.x, encl.y, i);
        positions[sec.agents[i]] = cubPos;
        assignedAgents.add(sec.agents[i]);
      }

      currentY += enclH + 14;
    }

    // ── Create Team button (after enclosures) ─────────────
    createTeamBtnPos = { x: 20, y: currentY };
    currentY += 30 + 18; // placeholder height + label + gap

    // ── Unassigned agents (not in any team and not CEO) ─────
    const unassigned = agents.filter(a => !assignedAgents.has(a.name));
    if (unassigned.length > 0) {
      let uCol = 0;
      for (const agent of unassigned) {
        positions[agent.name] = {
          x: 20 + uCol * (CW + GRID_PAD),
          y: currentY,
        };
        uCol++;
        if (uCol >= 5) { uCol = 0; currentY += CH + GRID_PAD + 10; }
      }
      currentY += CH + 24;
    }

    // ── Add Agent button ────────────────────────────────────
    addBtnPos = { x: 20, y: currentY };

    cubiclePositions = positions;
  }

  // ══════════════════════════════════════════════════════════
  //  ANIMATION STATE MACHINE
  // ══════════════════════════════════════════════════════════

  function updateAnimations() {
    for (const agent of agents) {
      const st = agentAnims[agent.name];
      if (!st) continue;

      if (st.bubble) {
        st.bubble.timer--;
        if (st.bubble.timer <= 0) st.bubble = null;
      }

      switch (st.animState) {
        case ANIM.SEATED:
          break;

        case ANIM.GETTING_UP:
          st.animTimer--;
          if (st.animTimer <= 0) {
            st.animPhase++;
            if (st.animPhase >= 3) {
              st.animState = ANIM.WALKING;
              st.animPhase = 0;
              st.walkPos = exitPos(st.homeCubPos);
            } else {
              st.animTimer = PHASE_TICKS;
            }
          }
          break;

        case ANIM.WALKING:
          if (!st.walkTarget) break;
          updateWalking(st);
          break;

        case ANIM.AT_LOCATION:
          break;

        case ANIM.SITTING_DOWN:
          st.animTimer--;
          if (st.animTimer <= 0) {
            st.animPhase++;
            if (st.animPhase >= 3) {
              st.animState = ANIM.SEATED;
              st.animPhase = 0;
            } else {
              st.animTimer = PHASE_TICKS;
            }
          }
          break;
      }
    }
  }

  function updateWalking(st) {
    const dx = st.walkTarget.x - st.walkPos.x;
    const dy = st.walkTarget.y - st.walkPos.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < WALK_SPEED + 1) {
      st.walkPos.x = st.walkTarget.x;
      st.walkPos.y = st.walkTarget.y;
      st.walkTarget = null;
      st.walkFrame = 0;

      const homeExit = exitPos(st.homeCubPos);
      const atHome = Math.abs(st.walkPos.x - homeExit.x) < 3 &&
                     Math.abs(st.walkPos.y - homeExit.y) < 3;

      if (atHome && st.destination === null) {
        startSittingDown(st);
      } else {
        st.animState = ANIM.AT_LOCATION;
        if (typeof window.onAgentArrived === 'function') {
          const agentName = getAgentNameByAnim(st);
          if (agentName) window.onAgentArrived(agentName, st.destination);
        }
      }
    } else {
      st.walkPos.x += (dx / dist) * WALK_SPEED;
      st.walkPos.y += (dy / dist) * WALK_SPEED;
      st.walkFrame++;

      if (Math.abs(dx) > Math.abs(dy)) {
        st.walkDirection = dx > 0 ? 'right' : 'left';
      } else {
        st.walkDirection = dy > 0 ? 'down' : 'up';
      }
    }
  }

  function getAgentNameByAnim(targetSt) {
    for (const [name, st] of Object.entries(agentAnims)) {
      if (st === targetSt) return name;
    }
    return null;
  }

  // ── Commands to move agents ──────────────────────────────

  function sendAgent(name, destination, targetPos) {
    const st = agentAnims[name];
    if (!st) return;
    const agent = agents.find(a => a.name === name);
    if (!agent) return;

    if (st.animState === ANIM.WALKING || st.animState === ANIM.GETTING_UP) {
      st.destination = destination;
      st.walkTarget = { ...targetPos };
      return;
    }

    if (st.animState === ANIM.AT_LOCATION) {
      st.destination = destination;
      st.walkTarget = { ...targetPos };
      st.animState = ANIM.WALKING;
      return;
    }

    if (st.animState === ANIM.SEATED && agent.status === 'working') {
      showBubble(name, 'Hold on...', 14);
      st.pendingCommand = { destination, targetPos };
      setTimeout(() => {
        const s = agentAnims[name];
        if (s && s.pendingCommand) {
          const cmd = s.pendingCommand;
          s.pendingCommand = null;
          showBubble(name, 'Omw!', 10);
          s.destination = cmd.destination;
          s.walkTarget = { ...cmd.targetPos };
          startGettingUp(s);
        }
      }, 800);
      return;
    }

    if (st.animState === ANIM.SEATED) {
      st.destination = destination;
      st.walkTarget = { ...targetPos };
      startGettingUp(st);
      return;
    }

    if (st.animState === ANIM.SITTING_DOWN) {
      st.pendingCommand = { destination, targetPos };
    }
  }

  function sendHome(name) {
    const st = agentAnims[name];
    if (!st) return;
    if (st.animState === ANIM.SEATED || st.animState === ANIM.SITTING_DOWN) return;

    st.destination = null;
    const homeExit = exitPos(st.homeCubPos);
    st.walkTarget = { ...homeExit };

    if (st.animState === ANIM.AT_LOCATION) {
      st.animState = ANIM.WALKING;
    }
  }

  function startGettingUp(st) {
    st.animState = ANIM.WALKING;
    st.animPhase = 0;
    st.walkPos = exitPos(st.homeCubPos);
  }

  function startSittingDown(st) {
    st.animState = ANIM.SEATED;
    st.animPhase = 0;

    if (st.pendingCommand) {
      const cmd = st.pendingCommand;
      st.pendingCommand = null;
      setTimeout(() => {
        st.destination = cmd.destination;
        st.walkTarget = { ...cmd.targetPos };
        startGettingUp(st);
      }, 100);
    }
  }

  // ── Speech bubbles ────────────────────────────────────────

  function showBubble(name, text, durationTicks) {
    const st = agentAnims[name];
    if (st) {
      st.bubble = { text, timer: durationTicks || 10 };
    }
  }

  // ── Team + meeting state ──────────────────────────────────

  function setTeamHighlights(highlights) {
    teamHighlights = highlights || {};
  }

  function setTeamSections(sections) {
    teamSections = sections || [];
  }

  function setMeetingNoteCount(count) {
    meetingNoteCount = count || 0;
  }

  function setCeoTodoCount(count) {
    ceoTodoCount = count || 0;
  }

  // ── Target position calculators ───────────────────────────

  function getDeskTargetPos(targetName) {
    const cubPos = cubiclePositions[targetName];
    if (!cubPos) return null;
    return { x: cubPos.x + CW / 2 - 5, y: cubPos.y + CH + 4 };
  }

  function getBoardTargetPos(boardType) {
    if (ceoBoardPos) {
      return { x: ceoBoardPos.x + BW / 2 - 5, y: ceoBoardPos.y + BH + 8 };
    }
    return null;
  }

  // ══════════════════════════════════════════════════════════
  //  RESIZE
  // ══════════════════════════════════════════════════════════

  function resize() {
    let maxX = 400, maxY = 300;

    // CEO board
    if (ceoBoardPos) {
      maxX = Math.max(maxX, ceoBoardPos.x + BW + 30);
      maxY = Math.max(maxY, ceoBoardPos.y + BH + 20);
    }

    // Cubicles
    for (const [name, pos] of Object.entries(cubiclePositions)) {
      maxX = Math.max(maxX, pos.x + CW + 30);
      maxY = Math.max(maxY, pos.y + CH + 30);
    }

    // Enclosures
    for (const encl of enclosureData) {
      maxX = Math.max(maxX, encl.x + encl.w + 30);
      maxY = Math.max(maxY, encl.y + encl.h + 30);
    }

    // Create team button
    if (createTeamBtnPos) {
      maxX = Math.max(maxX, createTeamBtnPos.x + CW * 2 + 14 + 30);
      maxY = Math.max(maxY, createTeamBtnPos.y + 30 + 20);
    }

    // Add button
    if (addBtnPos) {
      maxX = Math.max(maxX, addBtnPos.x + CW + 30);
      maxY = Math.max(maxY, addBtnPos.y + CH + 30);
    }

    const viewW = Math.max(maxX, Math.floor(window.innerWidth / S));
    const viewH = Math.max(maxY, Math.floor((window.innerHeight - 52) / S));
    canvas.width = viewW * S;
    canvas.height = viewH * S;
    canvas.style.width = `${viewW * S}px`;
    canvas.style.height = `${viewH * S}px`;
    ctx.imageSmoothingEnabled = false;
  }

  // ══════════════════════════════════════════════════════════
  //  RENDER
  // ══════════════════════════════════════════════════════════

  function render() {
    if (!ctx) return;
    const w = canvas.width, h = canvas.height;

    // Background floor
    drawFloor(w, h);

    // ── CEO Directives Board ────────────────────────────────
    if (ceoBoardPos) {
      const hov = hoverTarget?.type === 'ceoBoard';
      Sprites.drawBoard(ctx, ceoBoardPos.x, ceoBoardPos.y, 'CEO DIRECTIVES', ceoTodoCount, hov);
      ceoBoardRect = {
        x: ceoBoardPos.x * S, y: ceoBoardPos.y * S,
        w: BW * S, h: (BH + 8) * S,
      };
    }

    // ── Team Enclosures ─────────────────────────────────────
    enclosureRects = [];
    for (const encl of enclosureData) {
      const hov = hoverTarget?.type === 'enclosure' && hoverTarget.teamId === encl.teamId;
      Sprites.drawTeamEnclosure(
        ctx, encl.x, encl.y, encl.w, encl.h,
        encl.label, encl.type, encl.description,
        encl.color, hov, frame
      );
      enclosureRects.push({
        teamId: encl.teamId,
        x: encl.x * S, y: encl.y * S,
        w: encl.w * S, h: (Sprites.ENCL_WALL + Sprites.ENCL_HDR + 1) * S,
        // Only the header area is clickable for the team panel
      });
    }

    // ── Cubicles + seated agents ────────────────────────────
    cubicleRects = [];
    for (const agent of agents) {
      const cubPos = cubiclePositions[agent.name];
      if (!cubPos) continue;
      const st = agentAnims[agent.name];

      const isHov = hoverTarget?.type === 'cubicle' && hoverTarget.name === agent.name;
      const teamColor = teamHighlights[agent.name] || null;
      Sprites.drawCubicle(ctx, cubPos.x, cubPos.y, agent.tier || 'senior', isHov, teamColor);

      if (st) {
        renderAgentInCubicle(ctx, cubPos, agent, st);
      }

      const displayStatus = st && st.animState === ANIM.WALKING ? 'walking' :
                           st && st.animState === ANIM.AT_LOCATION ? 'paused' :
                           agent.status;
      Sprites.drawStatus(ctx, cubPos.x + CW / 2 - 2, cubPos.y - 3, displayStatus, frame);

      const namCol = isHov ? '#53d8fb' : '#bbbbdd';
      Sprites.drawLabel(ctx, cubPos.x + CW / 2, cubPos.y + CH + 5, agent.name, namCol);
      Sprites.drawRoleBadge(ctx, cubPos.x + CW / 2, cubPos.y + CH + 10, agent.role);
      Sprites.drawTierBadge(ctx, cubPos.x + CW / 2, cubPos.y + CH + 13, agent.tier || 'senior');

      cubicleRects.push({
        name: agent.name,
        x: cubPos.x * S, y: cubPos.y * S,
        w: CW * S, h: CH * S,
      });
    }

    // ── Create Team placeholder ─────────────────────────────
    if (createTeamBtnPos) {
      const hov = hoverTarget?.type === 'createTeam';
      Sprites.drawCreateTeamPlaceholder(ctx, createTeamBtnPos.x, createTeamBtnPos.y, hov);
      const ctW = CW * 2 + 14;
      createTeamBtnRect = {
        x: createTeamBtnPos.x * S, y: createTeamBtnPos.y * S,
        w: ctW * S, h: 30 * S,
      };
    }

    // ── Add Agent placeholder ───────────────────────────────
    if (addBtnPos) {
      const hov = hoverTarget?.type === 'add';
      Sprites.drawAddPlaceholder(ctx, addBtnPos.x, addBtnPos.y, hov);
      addBtnRect = {
        x: addBtnPos.x * S, y: addBtnPos.y * S,
        w: CW * S, h: CH * S,
      };
    }

    // ── Walking agents (drawn on top) ───────────────────────
    for (const agent of agents) {
      const st = agentAnims[agent.name];
      if (!st) continue;

      if (st.animState === ANIM.WALKING) {
        Sprites.drawAgentWalking(ctx, st.walkPos.x, st.walkPos.y,
          agent.avatar, st.walkDirection, st.walkFrame);
      } else if (st.animState === ANIM.AT_LOCATION) {
        Sprites.drawAgentStanding(ctx, st.walkPos.x, st.walkPos.y,
          agent.avatar, 'down');
      }
    }

    // ── Speech bubbles (topmost layer) ──────────────────────
    for (const agent of agents) {
      const st = agentAnims[agent.name];
      if (!st || !st.bubble) continue;

      let bx, by;
      if (st.animState === ANIM.SEATED || st.animState === ANIM.GETTING_UP ||
          st.animState === ANIM.SITTING_DOWN) {
        const cubPos = cubiclePositions[agent.name];
        if (cubPos) {
          bx = cubPos.x + CW / 2;
          by = cubPos.y + 5;
        }
      } else {
        bx = st.walkPos.x + 5;
        by = st.walkPos.y - 5;
      }

      if (bx !== undefined) {
        Sprites.drawSpeechBubble(ctx, bx, by, st.bubble.text);
      }
    }
  }

  function renderAgentInCubicle(ctx, cubPos, agent, st) {
    switch (st.animState) {
      case ANIM.SEATED:
        Sprites.drawAgentSeated(ctx, cubPos.x, cubPos.y, agent.avatar, frame);
        break;

      case ANIM.GETTING_UP:
        switch (st.animPhase) {
          case 0:
            Sprites.drawAgentTurnSide(ctx, cubPos.x, cubPos.y, agent.avatar, frame);
            break;
          case 1:
            Sprites.drawAgentSeatedFront(ctx, cubPos.x, cubPos.y, agent.avatar, frame);
            break;
          case 2:
            Sprites.drawAgentRising(ctx, cubPos.x, cubPos.y, agent.avatar, 1, frame);
            break;
        }
        break;

      case ANIM.WALKING:
      case ANIM.AT_LOCATION:
        Sprites.drawEmptyChair(ctx, cubPos.x, cubPos.y);
        break;

      case ANIM.SITTING_DOWN:
        switch (st.animPhase) {
          case 0:
            Sprites.drawAgentRising(ctx, cubPos.x, cubPos.y, agent.avatar, 0, frame);
            break;
          case 1:
            Sprites.drawAgentSeatedFront(ctx, cubPos.x, cubPos.y, agent.avatar, frame);
            break;
          case 2:
            Sprites.drawAgentTurnSide(ctx, cubPos.x, cubPos.y, agent.avatar, frame);
            break;
        }
        break;
    }
  }

  function drawFloor(w, h) {
    ctx.fillStyle = Sprites.C.floor;
    ctx.fillRect(0, 0, w, h);

    const tileSize = 12 * S;
    ctx.fillStyle = Sprites.C.floorAlt;
    for (let y = 0; y < h; y += tileSize * 2) {
      for (let x = 0; x < w; x += tileSize * 2) {
        ctx.fillRect(x, y, tileSize, tileSize);
        ctx.fillRect(x + tileSize, y + tileSize, tileSize, tileSize);
      }
    }

    ctx.strokeStyle = Sprites.C.floorGrid;
    ctx.lineWidth = 1;
    const gridStep = 24 * S;
    for (let x = 0; x < w; x += gridStep) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let y = 0; y < h; y += gridStep) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    ctx.fillStyle = Sprites.C.floorGlow;
    for (let y = 0; y < h; y += gridStep) {
      for (let x = 0; x < w; x += gridStep) {
        ctx.fillRect(x - 1, y - 1, 3, 3);
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  //  HIT TESTING + MOUSE EVENTS
  // ══════════════════════════════════════════════════════════

  function hitTest(mx, my) {
    // CEO board
    if (ceoBoardRect) {
      const r = ceoBoardRect;
      if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h)
        return { type: 'ceoBoard' };
    }

    // Enclosure headers (team panel click)
    for (const r of enclosureRects) {
      if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h)
        return { type: 'enclosure', teamId: r.teamId };
    }

    // Cubicles
    for (const r of cubicleRects) {
      if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h)
        return { type: 'cubicle', name: r.name };
    }

    // Walking agents
    for (const agent of agents) {
      const st = agentAnims[agent.name];
      if (st && (st.animState === ANIM.WALKING || st.animState === ANIM.AT_LOCATION)) {
        const ax = st.walkPos.x * S, ay = st.walkPos.y * S;
        if (mx >= ax - 5 && mx <= ax + 12 * S && my >= ay - 5 && my <= ay + 18 * S)
          return { type: 'cubicle', name: agent.name };
      }
    }

    // Create team button
    if (createTeamBtnRect) {
      const r = createTeamBtnRect;
      if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h)
        return { type: 'createTeam' };
    }

    // Add button
    if (addBtnRect) {
      const r = addBtnRect;
      if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h)
        return { type: 'add' };
    }

    return null;
  }

  function onMouseMove(e) {
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    hoverTarget = hitTest(mx, my);
    canvas.style.cursor = hoverTarget ? 'pointer' : 'default';
  }

  function onClick(e) {
    const r = canvas.getBoundingClientRect();
    const hit = hitTest(e.clientX - r.left, e.clientY - r.top);
    if (!hit) return;

    if (hit.type === 'cubicle' && window.onAgentClick) {
      window.onAgentClick(hit.name);
    } else if (hit.type === 'ceoBoard' && window.onCeoBoardClick) {
      window.onCeoBoardClick();
    } else if (hit.type === 'enclosure' && window.onTeamEnclosureClick) {
      window.onTeamEnclosureClick(hit.teamId);
    } else if (hit.type === 'createTeam' && window.onCreateTeamClick) {
      window.onCreateTeamClick();
    } else if (hit.type === 'add' && window.onAddAgentClick) {
      window.onAddAgentClick();
    }
  }

  // ── Task counts ───────────────────────────────────────────

  function updateTaskCounts(summaries) {
    // no-op — old boards removed; kept for backward compat
  }

  // ── Public query methods ──────────────────────────────────

  function getAnimState(name) {
    return agentAnims[name] || null;
  }

  function getAgents() { return agents; }

  function destroy() {
    if (animInterval) clearInterval(animInterval);
  }

  return {
    init, update, destroy,
    sendAgent, sendHome, showBubble,
    getDeskTargetPos, getBoardTargetPos,
    setTeamHighlights, setTeamSections, setMeetingNoteCount, setCeoTodoCount,
    updateTaskCounts,
    getAnimState, getAgents,
    ANIM,
  };
})();
