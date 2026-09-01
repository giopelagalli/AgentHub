// ============================================================
//  Sprites — pixel art engine with robot agents, digital boards
// ============================================================

const Sprites = (() => {
  const S = 3;

  // ── Palettes ──────────────────────────────────────────────
  // Robot palettes — body color identifies each bot, shared metal chassis
  const PALETTES = {
    blue:   { body:'#4488dd', dk:'#2a5599', visor:'#44ffaa' },
    green:  { body:'#44bb66', dk:'#2a8844', visor:'#ffdd44' },
    purple: { body:'#9955dd', dk:'#7733aa', visor:'#ff66aa' },
    red:    { body:'#dd4444', dk:'#aa2222', visor:'#ffaa44' },
    orange: { body:'#ee8833', dk:'#bb6622', visor:'#44ddff' },
    teal:   { body:'#33bbcc', dk:'#1a9999', visor:'#ffdd44' },
    yellow: { body:'#ddaa33', dk:'#aa8822', visor:'#44aaff' },
    pink:   { body:'#dd55aa', dk:'#aa3388', visor:'#66ffcc' },
  };

  // ── Tier style configs (neutral gray tones) ─────────────
  const TIERS = {
    director: {
      wallTop:'#484040', wall:'#3c3434', wallDk:'#2e2828', inner:'#282222',
      carpet:'#1e1a18', deskClr:'#6a4a12', deskTop:'#8a6818', deskW: 34,
      monW: 18, chairClr:'#2a2a30', chairW: 12,
    },
    manager: {
      wallTop:'#444448', wall:'#383840', wallDk:'#2c2c34', inner:'#262630',
      carpet:'#1c1c22', deskClr:'#8a6818', deskTop:'#a87828', deskW: 32,
      monW: 16, chairClr:'#2e2e36', chairW: 10,
    },
    senior: {
      wallTop:'#404044', wall:'#343438', wallDk:'#28282e', inner:'#242428',
      carpet:'#1a1a1e', deskClr:'#9a7020', deskTop:'#b8882e', deskW: 30,
      monW: 16, chairClr:'#323238', chairW: 10,
    },
    junior: {
      wallTop:'#3a3a3e', wall:'#303034', wallDk:'#24242a', inner:'#202024',
      carpet:'#181818', deskClr:'#8a7028', deskTop:'#a08030', deskW: 24,
      monW: 14, chairClr:'#363638', chairW: 8,
    },
  };

  const C = {
    // Floor — dark steel grid
    floor: '#111116', floorAlt: '#14141a',
    floorGrid: '#1e1e26', floorGlow: '#242830',

    // Monitor / desk
    monFrame:'#303038', monScreen:'#0a1a12', glow:'#22dd55', glowDim:'#118833',

    // Digital boards
    boardFrame: '#141418', boardBorder: '#3388cc', boardBorderGlow: '#44aaee',
    boardFace: '#0c1420', boardLine: '#162030',
    cardBg: '#141e2e', cardBgAlt: '#161e28', cardAccent: '#44aadd',
    cardGreen: '#1e4a30', cardYellow: '#4a4a18', cardRed: '#4a1a1a',

    // Decorations
    plant:'#2a8830', plantDk:'#1a6620', pot:'#8a5020',
    bookR:'#cc4444', bookB:'#4466cc', bookG:'#44aa44', bookY:'#ccaa22',
    paint:'#446688', paintFrame:'#6a5020',
    coffee:'#e8e0c8', coffeeIn:'#5a3a1a',

    // Speech bubble
    bubbleBg: '#f0ead0', bubbleBorder: '#22222a',

    // Robot chassis
    robotMetal: '#889098', robotMetalDk: '#505860',
    robotTread: '#282830', robotTreadRim: '#383840', robotTreadSeg: '#484850',

    // Team section walls
    wallHi: '#3a3a42', wallBody: '#2c2c34', wallShadow: '#1a1a20',
  };

  function rect(ctx, x, y, w, h, c) { ctx.fillStyle = c; ctx.fillRect(x*S, y*S, w*S, h*S); }
  function px(ctx, x, y, c) { ctx.fillStyle = c; ctx.fillRect(x*S, y*S, S, S); }

  const CUB_W = 48, CUB_H = 42;
  const BOARD_W = 28, BOARD_H = 22;

  // ── Draw Cubicle (tier-aware) ─────────────────────────────
  function drawCubicle(ctx, ox, oy, tier, highlighted, teamColor) {
    const t = TIERS[tier] || TIERS.senior;
    const w = CUB_W, h = CUB_H;

    // Floor
    rect(ctx, ox+4, oy+5, w-8, h-5, t.carpet);

    // Back wall
    rect(ctx, ox, oy, w, 2, t.wallTop);
    rect(ctx, ox, oy+2, w, 3, t.wall);
    rect(ctx, ox+4, oy+4, w-8, 1, t.inner);

    // Left wall
    rect(ctx, ox, oy, 4, h-4, t.wall);
    rect(ctx, ox, oy, 1, h-4, t.wallTop);
    rect(ctx, ox+4, oy+5, 1, h-9, t.inner);

    // Right wall
    rect(ctx, ox+w-4, oy, 4, h-4, t.wall);
    rect(ctx, ox+w-1, oy, 1, h-4, t.wallDk);
    rect(ctx, ox+w-5, oy+5, 1, h-9, t.inner);

    // Entrance lips
    rect(ctx, ox, oy+h-4, 5, 1, t.wallDk);
    rect(ctx, ox+w-5, oy+h-4, 5, 1, t.wallDk);

    // ── Tier decorations on back wall ──────────
    if (tier === 'director') {
      rect(ctx, ox+8, oy+2, 10, 3, C.paintFrame);
      rect(ctx, ox+9, oy+2, 8, 2, C.paint);
      rect(ctx, ox+w-10, oy+28, 3, 4, C.pot);
      rect(ctx, ox+w-11, oy+25, 2, 3, C.plant);
      rect(ctx, ox+w-9, oy+24, 2, 4, C.plant);
      rect(ctx, ox+w-8, oy+26, 2, 2, C.plantDk);
    }
    if (tier === 'manager') {
      rect(ctx, ox+w-13, oy+5, 7, 8, t.wallDk);
      rect(ctx, ox+w-12, oy+5, 2, 7, C.bookR);
      rect(ctx, ox+w-10, oy+6, 2, 6, C.bookB);
      rect(ctx, ox+w-8, oy+5, 2, 7, C.bookG);
    }

    // ── Desk ───────────────────────────────────
    const dw = t.deskW;
    const dx = ox + (w - dw) / 2;
    const dy = oy + 14;
    rect(ctx, dx, dy, dw, 1, t.deskTop);
    rect(ctx, dx, dy+1, dw, 4, t.deskClr);
    rect(ctx, dx, dy+5, dw, 1, t.wallDk);
    rect(ctx, dx+1, dy+5, 2, 2, t.wallDk);
    rect(ctx, dx+dw-3, dy+5, 2, 2, t.wallDk);

    // ── Monitor ────────────────────────────────
    const mw = t.monW;
    const mx = ox + (w - mw) / 2;
    const my = oy + 8;
    rect(ctx, mx + mw/2 - 2, my+5, 4, 2, C.monFrame);
    rect(ctx, mx + mw/2 - 3, my+6, 6, 1, C.monFrame);
    rect(ctx, mx, my, mw, 5, C.monFrame);
    rect(ctx, mx+1, my+1, mw-2, 3, C.monScreen);

    const phase = Math.floor(Date.now() / 2000);
    const sw = mw - 4;
    for (let r = 0; r < 3; r++) {
      const len = ((r + phase) * 5 + 3) % sw + 2;
      rect(ctx, mx+2, my+1+r, Math.min(len, sw), 1, r % 2 ? C.glowDim : C.glow);
    }

    // ── Coffee mug (senior+) ──────────────────
    if (tier === 'senior' || tier === 'manager') {
      const cx = dx + dw - 5;
      rect(ctx, cx, dy-1, 3, 3, C.coffee);
      rect(ctx, cx, dy, 3, 2, C.coffeeIn);
      px(ctx, cx+3, dy, C.coffee);
    }

    // ── Team color highlight (glowing border) ──
    if (teamColor) {
      const pulse = (Math.sin(Date.now() / 400) + 1) / 2;
      const alpha = 0.3 + pulse * 0.5;
      ctx.save();
      ctx.strokeStyle = teamColor;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = S * 2;
      ctx.strokeRect(ox*S - S, oy*S - S, w*S + S*2, h*S + S*2);
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    // Edit / hover highlight
    if (highlighted) {
      ctx.strokeStyle = '#53d8fb';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(ox*S-2, oy*S-2, w*S+4, h*S+4);
      ctx.setLineDash([]);
    }
  }

  // ── Empty station (when robot has left) ────────────────────
  function drawEmptyChair(ctx, ox, oy) {
    // Robots ARE the furniture — nothing to draw when gone
  }

  // ══════════════════════════════════════════════════════════
  //  ROBOT SPRITES — all poses (single-leg tread chassis)
  // ══════════════════════════════════════════════════════════

  // ── Shared: single vertical tread block ─────────────────
  function drawTread(ctx, x, y, frame, moving) {
    // One block: 4w × 5h, vertical segments
    rect(ctx, x, y, 4, 1, C.robotTreadRim);      // top rim
    rect(ctx, x, y+1, 4, 3, C.robotTread);        // body (3 rows)
    rect(ctx, x, y+4, 4, 1, C.robotTreadRim);     // bottom rim
    // Vertical animated segments (scroll down when moving)
    const off = moving ? (frame % 3) : 1;
    for (let j = 0; j < 3; j++) {
      if ((j + off) % 3 === 0) {
        px(ctx, x+1, y+1+j, C.robotTreadSeg);
        px(ctx, x+2, y+1+j, C.robotTreadSeg);
      }
    }
  }

  // ── Shared: draw central support leg ──────────────────────
  function drawSupportLeg(ctx, cx, y) {
    // 4px wide, 2px tall metal column
    rect(ctx, cx-2, y, 4, 1, C.robotMetal);
    rect(ctx, cx-2, y+1, 4, 1, C.robotMetalDk);
  }

  // ── Robot at station (back view, facing desk/monitor) ─────
  function drawAgentSeated(ctx, ox, oy, palette, frame) {
    const p = PALETTES[palette] || PALETTES.blue;
    const cx = ox + 24;

    // Antenna (periodic blink)
    const blink = frame % 30 < 2;
    px(ctx, cx-1, oy+14, blink ? '#fff' : p.visor);
    px(ctx, cx,   oy+14, blink ? '#fff' : p.visor);

    // Head (back — all metal)
    rect(ctx, cx-3, oy+15, 6, 3, C.robotMetal);
    rect(ctx, cx-3, oy+18, 6, 1, C.robotMetalDk);

    // Body (back view)
    rect(ctx, cx-4, oy+19, 8, 4, p.body);
    px(ctx, cx-4, oy+19, p.dk);
    px(ctx, cx+3, oy+19, p.dk);
    rect(ctx, cx-2, oy+21, 4, 1, p.dk);   // back panel

    // Arms (metal)
    rect(ctx, cx-5, oy+20, 1, 2, C.robotMetal);
    rect(ctx, cx+4, oy+20, 1, 2, C.robotMetal);

    // Central support leg
    drawSupportLeg(ctx, cx, oy+23);

    // Single vertical tread (aligned under leg)
    drawTread(ctx, cx-2, oy+25, frame, false);
  }

  // ── Transitional poses (instant for robots) ──────────────
  function drawAgentTurnSide(ctx, ox, oy, palette, frame) {
    drawAgentSeated(ctx, ox, oy, palette, frame);
  }
  function drawAgentSeatedFront(ctx, ox, oy, palette, frame) {
    drawAgentSeated(ctx, ox, oy, palette, frame);
  }
  function drawAgentRising(ctx, ox, oy, palette, phase, frame) {
    drawAgentSeated(ctx, ox, oy, palette, frame);
  }

  // ── Robot moving (animated treads) ────────────────────────
  function drawAgentWalking(ctx, ax, ay, palette, direction, frame) {
    const p = PALETTES[palette] || PALETTES.blue;
    const x = Math.round(ax), y = Math.round(ay);

    // Antenna (blink)
    const blink = frame % 20 < 2;
    px(ctx, x+4, y, blink ? '#fff' : p.visor);
    px(ctx, x+5, y, blink ? '#fff' : p.visor);

    // ── Head (direction-specific) ──
    if (direction === 'up') {
      // Back of head — all metal
      rect(ctx, x+2, y+1, 6, 3, C.robotMetal);
      rect(ctx, x+2, y+4, 6, 1, C.robotMetalDk);
    } else if (direction === 'left') {
      rect(ctx, x+2, y+1, 5, 1, C.robotMetal);
      rect(ctx, x+2, y+2, 5, 1, C.robotMetal);
      px(ctx, x+3, y+2, p.visor);
      rect(ctx, x+2, y+3, 5, 1, C.robotMetal);
      rect(ctx, x+2, y+4, 5, 1, C.robotMetalDk);
    } else if (direction === 'right') {
      rect(ctx, x+3, y+1, 5, 1, C.robotMetal);
      rect(ctx, x+3, y+2, 5, 1, C.robotMetal);
      px(ctx, x+6, y+2, p.visor);
      rect(ctx, x+3, y+3, 5, 1, C.robotMetal);
      rect(ctx, x+3, y+4, 5, 1, C.robotMetalDk);
    } else {
      // Front face (down / default)
      rect(ctx, x+2, y+1, 6, 1, C.robotMetal);
      rect(ctx, x+2, y+2, 6, 1, C.robotMetal);
      px(ctx, x+3, y+2, p.visor);    // left eye
      px(ctx, x+6, y+2, p.visor);    // right eye
      rect(ctx, x+2, y+3, 6, 1, C.robotMetal);
      rect(ctx, x+2, y+4, 6, 1, C.robotMetalDk);
    }

    // ── Body ──
    rect(ctx, x+1, y+5, 8, 3, p.body);
    px(ctx, x+1, y+5, p.dk);
    px(ctx, x+8, y+5, p.dk);
    px(ctx, x+4, y+6, p.visor);  // chest indicator L
    px(ctx, x+5, y+6, p.visor);  // chest indicator R

    // ── Arms ──
    rect(ctx, x, y+5, 1, 2, C.robotMetal);
    rect(ctx, x+9, y+5, 1, 2, C.robotMetal);

    // ── Central support leg ──
    rect(ctx, x+3, y+8, 4, 1, C.robotMetal);
    rect(ctx, x+3, y+9, 4, 1, C.robotMetalDk);

    // ── Single vertical tread (animated) ──
    drawTread(ctx, x+3, y+10, frame, true);
  }

  // ── Robot standing (static treads) ────────────────────────
  function drawAgentStanding(ctx, ax, ay, palette, direction) {
    drawAgentWalking(ctx, ax, ay, palette, direction || 'down', 5);
  }

  // ── Robot at table (kept for future meeting visuals) ──────
  function drawAgentAtTable(ctx, ax, ay, palette, frame, facingUp) {
    const p = PALETTES[palette] || PALETTES.blue;
    const x = Math.round(ax), y = Math.round(ay);

    if (facingUp) {
      // Back view (facing table)
      px(ctx, x+4, y, p.visor); px(ctx, x+5, y, p.visor);
      rect(ctx, x+2, y+1, 6, 3, C.robotMetal);
      rect(ctx, x+2, y+4, 6, 1, C.robotMetalDk);
      rect(ctx, x+1, y+5, 8, 2, p.body);
      px(ctx, x, y+5, C.robotMetal); px(ctx, x+9, y+5, C.robotMetal);
      // Support leg
      rect(ctx, x+3, y+7, 4, 1, C.robotMetal);
      rect(ctx, x+3, y+8, 4, 1, C.robotMetalDk);
      drawTread(ctx, x+3, y+9, frame, false);
    } else {
      // Front view (facing camera)
      px(ctx, x+4, y, p.visor); px(ctx, x+5, y, p.visor);
      rect(ctx, x+2, y+1, 6, 2, C.robotMetal);
      px(ctx, x+3, y+2, p.visor); px(ctx, x+6, y+2, p.visor);
      rect(ctx, x+2, y+3, 6, 1, C.robotMetalDk);
      rect(ctx, x+1, y+4, 8, 2, p.body);
      px(ctx, x, y+4, C.robotMetal); px(ctx, x+9, y+4, C.robotMetal);
      px(ctx, x+4, y+5, p.visor); px(ctx, x+5, y+5, p.visor);
      // Support leg
      rect(ctx, x+3, y+6, 4, 1, C.robotMetal);
      rect(ctx, x+3, y+7, 4, 1, C.robotMetalDk);
      drawTread(ctx, x+3, y+8, frame, false);
    }
  }

  // ══════════════════════════════════════════════════════════
  //  SPEECH BUBBLES
  // ══════════════════════════════════════════════════════════

  function drawSpeechBubble(ctx, cx, cy, text) {
    ctx.save();
    ctx.font = `bold ${S * 2.5}px monospace`;
    const tm = ctx.measureText(text);
    const textW = Math.ceil(tm.width / S) + 4;
    const bw = Math.max(textW + 4, 14);
    const bh = 7;
    const bx = Math.round(cx - bw / 2);
    const by = Math.round(cy - bh - 3);

    // Bubble fill (rounded corners via pixel art)
    rect(ctx, bx + 2, by, bw - 4, bh, C.bubbleBg);
    rect(ctx, bx + 1, by + 1, bw - 2, bh - 2, C.bubbleBg);
    rect(ctx, bx, by + 2, bw, bh - 4, C.bubbleBg);

    // Border — top edge
    rect(ctx, bx + 2, by - 1, bw - 4, 1, C.bubbleBorder);
    px(ctx, bx + 1, by, C.bubbleBorder);
    px(ctx, bx + bw - 2, by, C.bubbleBorder);
    // Border — bottom edge
    rect(ctx, bx + 2, by + bh, bw - 4, 1, C.bubbleBorder);
    px(ctx, bx + 1, by + bh - 1, C.bubbleBorder);
    px(ctx, bx + bw - 2, by + bh - 1, C.bubbleBorder);
    // Border — left/right
    rect(ctx, bx - 1, by + 2, 1, bh - 4, C.bubbleBorder);
    px(ctx, bx, by + 1, C.bubbleBorder);
    px(ctx, bx, by + bh - 2, C.bubbleBorder);
    rect(ctx, bx + bw, by + 2, 1, bh - 4, C.bubbleBorder);
    px(ctx, bx + bw - 1, by + 1, C.bubbleBorder);
    px(ctx, bx + bw - 1, by + bh - 2, C.bubbleBorder);

    // Tail pointing down to agent
    rect(ctx, cx - 1, by + bh, 3, 1, C.bubbleBg);
    px(ctx, cx, by + bh + 1, C.bubbleBg);
    // Tail border
    px(ctx, cx - 2, by + bh, C.bubbleBorder);
    px(ctx, cx + 2, by + bh, C.bubbleBorder);
    px(ctx, cx - 1, by + bh + 1, C.bubbleBorder);
    px(ctx, cx + 1, by + bh + 1, C.bubbleBorder);
    px(ctx, cx, by + bh + 2, C.bubbleBorder);

    // Text
    ctx.fillStyle = C.bubbleBorder;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, cx * S, (by + bh / 2) * S);
    ctx.restore();
  }

  // ══════════════════════════════════════════════════════════
  //  STATUS INDICATORS
  // ══════════════════════════════════════════════════════════

  function drawStatus(ctx, cx, cy, status, frame) {
    switch (status) {
      case 'idle':
        if (frame % 24 < 12) {
          px(ctx, cx, cy, '#6666aa');
          px(ctx, cx+1, cy-1, '#5555aa');
        }
        break;
      case 'working': {
        const g = frame % 10 < 5 ? '#4ade80' : '#22c55e';
        rect(ctx, cx-1, cy, 3, 1, g);
        rect(ctx, cx, cy-1, 1, 3, g);
        break;
      }
      case 'thinking':
        [[0,0],[2,0],[4,0]].forEach((d,i) => {
          px(ctx, cx+d[0], cy+d[1], ((frame+i*3)%9)<4 ? '#facc15' : '#4a4a2a');
        });
        break;
      case 'paused': {
        const c = frame % 8 < 4 ? '#fb923c' : '#ea580c';
        rect(ctx, cx, cy, 1, 3, c);
        rect(ctx, cx+2, cy, 1, 3, c);
        break;
      }
      case 'walking': {
        const c = '#8888cc';
        if (frame % 6 < 3) { px(ctx, cx, cy, c); px(ctx, cx+2, cy+1, c); }
        else { px(ctx, cx+1, cy, c); px(ctx, cx+3, cy+1, c); }
        break;
      }
      case 'error':
        px(ctx, cx+1, cy-2, '#ef4444');
        px(ctx, cx+1, cy-1, '#ef4444');
        if (frame%6<3) px(ctx, cx+1, cy+1, '#ef4444');
        break;
    }
  }

  // ══════════════════════════════════════════════════════════
  //  DIGITAL HOLOGRAPHIC BOARDS
  // ══════════════════════════════════════════════════════════

  function drawBoard(ctx, ox, oy, label, count, hov) {
    // Dark frame with glowing border
    rect(ctx, ox, oy, BOARD_W, BOARD_H, C.boardFrame);
    rect(ctx, ox+1, oy+1, BOARD_W-2, BOARD_H-2, C.boardFace);

    // Glowing border lines
    const glowC = hov ? '#66ccff' : C.boardBorder;
    rect(ctx, ox, oy, BOARD_W, 1, glowC);
    rect(ctx, ox, oy+BOARD_H-1, BOARD_W, 1, glowC);
    rect(ctx, ox, oy, 1, BOARD_H, glowC);
    rect(ctx, ox+BOARD_W-1, oy, 1, BOARD_H, glowC);

    // Inner grid lines (subtle data display)
    for (let ly = 4; ly < BOARD_H - 2; ly += 4) {
      rect(ctx, ox+2, oy+ly, BOARD_W-4, 1, C.boardLine);
    }

    // Data cards (holographic sticky notes)
    const cards = [
      {x:3, y:2, w:5, h:3, c:C.cardBg},
      {x:9, y:2, w:5, h:3, c:C.cardBgAlt},
      {x:15,y:3, w:6, h:3, c:C.cardBg},
      {x:3, y:9, w:7, h:3, c:C.cardBgAlt},
      {x:12,y:9, w:6, h:3, c:C.cardBg},
    ];
    const statusColors = [C.cardAccent, C.cardGreen, C.cardYellow, C.cardRed, C.cardAccent];
    for (let i = 0; i < Math.min(count||0, cards.length); i++) {
      const cd = cards[i];
      rect(ctx, ox+cd.x, oy+cd.y, cd.w, cd.h, cd.c);
      // Status indicator dot on each card
      px(ctx, ox+cd.x+cd.w-1, oy+cd.y, statusColors[i % statusColors.length]);
      // Text line placeholder
      rect(ctx, ox+cd.x+1, oy+cd.y+1, cd.w-2, 1, C.boardLine);
    }

    // Scanline effect (subtle animated line)
    const scanY = (Math.floor(Date.now() / 150) % (BOARD_H - 4)) + 2;
    ctx.save();
    ctx.globalAlpha = 0.15;
    rect(ctx, ox+1, oy+scanY, BOARD_W-2, 1, C.boardBorderGlow);
    ctx.globalAlpha = 1;
    ctx.restore();

    // Label below
    ctx.save();
    ctx.fillStyle = hov ? '#53d8fb' : '#7a7a8a';
    ctx.font = `bold ${S*3.5}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(label, (ox+BOARD_W/2)*S, (oy+BOARD_H+5)*S);
    ctx.restore();
    if (hov) {
      ctx.strokeStyle = '#53d8fb'; ctx.lineWidth = 2;
      ctx.strokeRect(ox*S-2, oy*S-2, BOARD_W*S+4, BOARD_H*S+4);
    }
  }

  // ── Meeting Notes board (same digital style, different icon) ──
  function drawMeetingBoard(ctx, ox, oy, label, noteCount, hov) {
    // Same frame as regular board
    rect(ctx, ox, oy, BOARD_W, BOARD_H, C.boardFrame);
    rect(ctx, ox+1, oy+1, BOARD_W-2, BOARD_H-2, C.boardFace);

    // Glowing border (slightly different color for meetings)
    const glowC = hov ? '#ff88cc' : '#aa55aa';
    rect(ctx, ox, oy, BOARD_W, 1, glowC);
    rect(ctx, ox, oy+BOARD_H-1, BOARD_W, 1, glowC);
    rect(ctx, ox, oy, 1, BOARD_H, glowC);
    rect(ctx, ox+BOARD_W-1, oy, 1, BOARD_H, glowC);

    // Meeting icon (chat bubble shape in center if no notes)
    if ((noteCount || 0) === 0) {
      // Empty board — show a centered chat icon
      rect(ctx, ox+8, oy+6, 12, 8, '#1a2a40');
      rect(ctx, ox+9, oy+7, 10, 6, '#2a3a50');
      rect(ctx, ox+10, oy+8, 8, 1, '#44aadd');
      rect(ctx, ox+10, oy+10, 6, 1, '#44aadd');
      // Tail
      rect(ctx, ox+10, oy+14, 2, 2, '#2a3a50');
    } else {
      // Show meeting note cards
      for (let i = 0; i < Math.min(noteCount, 4); i++) {
        const ny = 2 + i * 5;
        rect(ctx, ox+3, oy+ny, BOARD_W-6, 4, C.cardBg);
        rect(ctx, ox+4, oy+ny+1, BOARD_W-8, 1, '#44aadd');
        rect(ctx, ox+4, oy+ny+2, BOARD_W-10, 1, C.boardLine);
      }
    }

    // Scanline
    const scanY = (Math.floor(Date.now() / 200) % (BOARD_H - 4)) + 2;
    ctx.save();
    ctx.globalAlpha = 0.12;
    rect(ctx, ox+1, oy+scanY, BOARD_W-2, 1, '#cc66cc');
    ctx.globalAlpha = 1;
    ctx.restore();

    // Label
    ctx.save();
    ctx.fillStyle = hov ? '#ff88cc' : '#887090';
    ctx.font = `bold ${S*3.5}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(label, (ox+BOARD_W/2)*S, (oy+BOARD_H+5)*S);
    ctx.restore();
    if (hov) {
      ctx.strokeStyle = '#ff88cc'; ctx.lineWidth = 2;
      ctx.strokeRect(ox*S-2, oy*S-2, BOARD_W*S+4, BOARD_H*S+4);
    }
  }

  // ══════════════════════════════════════════════════════════
  //  UI ELEMENTS
  // ══════════════════════════════════════════════════════════

  function drawAddPlaceholder(ctx, ox, oy, hov) {
    const w = CUB_W, h = CUB_H, c = hov ? '#53d8fb' : '#333340';
    ctx.strokeStyle = c; ctx.lineWidth = S;
    ctx.setLineDash([S*3, S*3]);
    ctx.strokeRect(ox*S+S*2, oy*S+S*2, (w-4)*S, (h-4)*S);
    ctx.setLineDash([]);
    rect(ctx, ox+w/2-1, oy+h/2-5, 2, 10, c);
    rect(ctx, ox+w/2-5, oy+h/2-1, 10, 2, c);
    ctx.save();
    ctx.fillStyle = hov ? '#53d8fb' : '#555560';
    ctx.font = `${S*3}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillText('Add Agent', (ox+w/2)*S, (oy+h+4)*S);
    ctx.restore();
  }

  /** Draw a "Create Team" dashed placeholder (wider than Add Agent) */
  function drawCreateTeamPlaceholder(ctx, ox, oy, hov) {
    const w = CUB_W * 2 + 14;  // wider — roughly 2 cubicle widths
    const h = 30;               // shorter than cubicle
    const c = hov ? '#cc8833' : '#333340';
    ctx.strokeStyle = c; ctx.lineWidth = S;
    ctx.setLineDash([S*3, S*3]);
    ctx.strokeRect(ox*S+S*2, oy*S+S*2, (w-4)*S, (h-4)*S);
    ctx.setLineDash([]);
    rect(ctx, ox+w/2-1, oy+h/2-4, 2, 8, c);
    rect(ctx, ox+w/2-4, oy+h/2-1, 8, 2, c);
    ctx.save();
    ctx.fillStyle = hov ? '#cc8833' : '#555560';
    ctx.font = `${S*3}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillText('Create Team', (ox+w/2)*S, (oy+h+4)*S);
    ctx.restore();
  }

  function drawLabel(ctx, cx, cy, text, color) {
    ctx.save();
    ctx.fillStyle = color || '#b0b0be';
    ctx.font = `bold ${S*3.5}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(text, cx*S, cy*S);
    ctx.restore();
  }

  function drawRoleBadge(ctx, cx, cy, text) {
    ctx.save();
    ctx.fillStyle = '#707080';
    ctx.font = `${S*2.5}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(text, cx*S, cy*S);
    ctx.restore();
  }

  function drawTierBadge(ctx, cx, cy, tier) {
    const colors = { director:'#ffd700', manager:'#c0c0c0', senior:'#cd7f32', junior:'#888888' };
    const labels = { director:'DIR', manager:'MGR', senior:'SNR', junior:'JNR' };
    const c = colors[tier] || colors.senior;
    ctx.save();
    ctx.fillStyle = c;
    ctx.font = `${S*2}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(labels[tier] || 'SNR', cx*S, cy*S);
    ctx.restore();
  }

  // ── Progress bar ──────────────────────────────────────────
  function drawProgressBar(ctx, x, y, w, progress, color) {
    rect(ctx, x, y, w, 2, '#141418');
    const fillW = Math.round(w * Math.min(1, Math.max(0, progress)));
    if (fillW > 0) {
      rect(ctx, x, y, fillW, 2, color || '#4ade80');
    }
    px(ctx, x - 1, y, '#333');
    px(ctx, x - 1, y + 1, '#333');
    px(ctx, x + w, y, '#333');
    px(ctx, x + w, y + 1, '#333');
  }

  // ══════════════════════════════════════════════════════════
  //  TEAM ENCLOSURES (walled rooms around team agents)
  // ══════════════════════════════════════════════════════════

  // Enclosure layout constants (pixel-art units)
  const ENCL_WALL = 3;
  const ENCL_HDR  = 14;    // header area height (type badge + name)
  const ENCL_PAD  = 5;     // inner padding
  const ENCL_CUB_LABELS = 18; // space below cubicles for name/role labels

  /**
   * Draw a team enclosure — walled room with header sign.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x - left edge (pixel-art coords)
   * @param {number} y - top edge
   * @param {number} w - width
   * @param {number} h - height
   * @param {string} teamName
   * @param {string} teamType - 'research' or 'production'
   * @param {string} description - what team is working on
   * @param {string} color - team color
   * @param {boolean} isHover
   * @param {number} frame - animation frame
   */
  function drawTeamEnclosure(ctx, x, y, w, h, teamName, teamType, description, color, isHover, frame) {
    const wHi = C.wallHi;
    const wBody = C.wallBody;
    const wDk = C.wallShadow;

    // ── Outer walls ────────────────────────────────────────
    // Top wall
    rect(ctx, x, y, w, 1, wHi);
    rect(ctx, x, y+1, w, 1, wBody);
    rect(ctx, x, y+2, w, 1, wDk);
    // Left wall
    rect(ctx, x, y, 1, h, wHi);
    rect(ctx, x+1, y, 1, h, wBody);
    rect(ctx, x+2, y, 1, h, wDk);
    // Right wall
    rect(ctx, x+w-3, y, 1, h, wHi);
    rect(ctx, x+w-2, y, 1, h, wBody);
    rect(ctx, x+w-1, y, 1, h, wDk);
    // Bottom wall
    rect(ctx, x, y+h-3, w, 1, wHi);
    rect(ctx, x, y+h-2, w, 1, wBody);
    rect(ctx, x, y+h-1, w, 1, '#141418');

    // ── Inner floor (team-tinted) ──────────────────────────
    ctx.save();
    ctx.fillStyle = color || '#53d8fb';
    ctx.globalAlpha = 0.05;
    ctx.fillRect((x+3)*S, (y+3)*S, (w-6)*S, (h-6)*S);
    ctx.globalAlpha = 1;
    ctx.restore();

    // ── Header area ────────────────────────────────────────
    const hdrX = x + ENCL_WALL;
    const hdrY = y + ENCL_WALL;
    const hdrW = w - ENCL_WALL * 2;

    // Header background
    rect(ctx, hdrX, hdrY, hdrW, ENCL_HDR, '#181820');

    // Type badge
    const isResearch = teamType === 'research';
    const badgeColor = isResearch ? '#3388cc' : '#cc8833';
    const badgeText = isResearch ? 'RESEARCH' : 'PROJECT';

    ctx.save();
    ctx.font = `bold ${S*2.5}px monospace`;
    const btw = ctx.measureText(badgeText).width;
    const badgePxW = Math.ceil(btw / S) + 4;
    // Badge rect
    rect(ctx, hdrX + 2, hdrY + 2, badgePxW, 6, badgeColor);
    rect(ctx, hdrX + 2, hdrY + 2, badgePxW, 1, '#ffffff20');
    // Badge text
    ctx.fillStyle = '#111';
    ctx.textBaseline = 'middle';
    ctx.fillText(badgeText, (hdrX + 4) * S, (hdrY + 5) * S);

    // Team name (next to badge)
    const nameX = hdrX + 2 + badgePxW + 4;
    ctx.fillStyle = color || '#53d8fb';
    ctx.fillText(teamName || '', nameX * S, (hdrY + 5) * S);

    // Description line (smaller, below type badge)
    if (description) {
      ctx.font = `${S*2}px monospace`;
      ctx.fillStyle = '#606068';
      ctx.fillText(description, (hdrX + 4) * S, (hdrY + 11) * S);
    }
    ctx.restore();

    // Separator line under header
    rect(ctx, hdrX, hdrY + ENCL_HDR, hdrW, 1, wDk);

    // ── Hover/active glow ──────────────────────────────────
    if (isHover) {
      ctx.save();
      ctx.strokeStyle = color || '#53d8fb';
      ctx.lineWidth = S;
      ctx.globalAlpha = 0.35 + 0.12 * Math.sin((frame || 0) * 0.15);
      ctx.strokeRect(x*S - 1, y*S - 1, w*S + 2, h*S + 2);
      ctx.globalAlpha = 1;
      ctx.restore();
    }
  }

  /** Get the enclosure inner dimensions for N agents */
  function getEnclosureSize(numAgents) {
    const slots = Math.max(numAgents, 2);
    const innerW = slots * (CUB_W + 14) - 14; // 14 = grid pad
    const w = ENCL_WALL*2 + ENCL_PAD*2 + innerW;
    const h = ENCL_WALL*2 + ENCL_HDR + 1 + ENCL_PAD*2 + CUB_H + ENCL_CUB_LABELS;
    return { w, h, innerW };
  }

  /** Get cubicle position inside an enclosure */
  function getEnclosureCubPos(enclX, enclY, slotIndex) {
    return {
      x: enclX + ENCL_WALL + ENCL_PAD + slotIndex * (CUB_W + 14),
      y: enclY + ENCL_WALL + ENCL_HDR + 1 + ENCL_PAD,
    };
  }

  return {
    S, PALETTES, C, TIERS, CUB_W, CUB_H, BOARD_W, BOARD_H,
    ENCL_WALL, ENCL_HDR, ENCL_PAD, ENCL_CUB_LABELS,
    rect, px,
    drawCubicle, drawEmptyChair,
    drawAgentSeated, drawAgentTurnSide, drawAgentSeatedFront, drawAgentRising,
    drawAgentWalking, drawAgentStanding, drawAgentAtTable,
    drawSpeechBubble, drawStatus, drawProgressBar,
    drawBoard, drawMeetingBoard,
    drawTeamEnclosure, getEnclosureSize, getEnclosureCubPos,
    drawAddPlaceholder, drawCreateTeamPlaceholder,
    drawLabel, drawRoleBadge, drawTierBadge,
  };
})();
