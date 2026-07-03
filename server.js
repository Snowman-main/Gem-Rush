// ============================================================
//  GEM RUSH - multiplayer arena game server
//  Room flow: party lobby -> match -> back to party lobby
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// WebRTC data channels (UDP): game traffic that never stalls on packet loss.
// Optional - if the native module is unavailable everything falls back to WebSocket.
let ndc = null;
try { ndc = require('node-datachannel'); } catch { console.log('node-datachannel unavailable - WebSocket-only mode'); }
const STUN = ['stun:stun.l.google.com:19302'];

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------- static file server ----------------
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------------- game constants ----------------
// NOTE: movement constants are mirrored in public/client.js (prediction) - keep in sync
const TICK_MS = 1000 / 30;
const WORLD = { w: 2400, h: 1800 };

const WALLS = [
  // corner L-covers
  { x: 400,  y: 300,  w: 260, h: 70 }, { x: 400,  y: 300,  w: 70,  h: 260 },
  { x: 1740, y: 300,  w: 260, h: 70 }, { x: 1930, y: 300,  w: 70,  h: 260 },
  { x: 400,  y: 1430, w: 260, h: 70 }, { x: 400,  y: 1240, w: 70,  h: 260 },
  { x: 1740, y: 1430, w: 260, h: 70 }, { x: 1930, y: 1240, w: 70,  h: 260 },
  // mid pillars around the gem mine
  { x: 1130, y: 500,  w: 140, h: 80 },
  { x: 1130, y: 1220, w: 140, h: 80 },
  { x: 600,  y: 830,  w: 80,  h: 140 },
  { x: 1720, y: 830,  w: 80,  h: 140 },
];

// indexes: 0 TL, 1 TR, 2 BL, 3 BR, 4 top-mid, 5 bottom-mid, 6 left-mid, 7 right-mid
const SPAWN_POINTS = [
  { x: 160, y: 160 }, { x: 2240, y: 160 }, { x: 160, y: 1640 }, { x: 2240, y: 1640 },
  { x: 1200, y: 140 }, { x: 1200, y: 1660 }, { x: 140, y: 900 }, { x: 2260, y: 900 },
];

// which spawn points each team uses (keeps teams starting near each other)
const TEAM_SPAWNS = {
  teams2: [[0, 2, 6], [1, 3, 7]],
  teams4: [[0, 6], [1, 4], [2, 5], [3, 7]],
};

const MODES = { ffa: 0, teams2: 2, teams4: 4 };  // mode -> team count
const TEAM_COLORS = ['#e8563f', '#4dc3ff', '#8fce4e', '#b07fff'];
const TEAM_NAMES = ['RED', 'BLUE', 'GREEN', 'PURPLE'];

const PLAYER_R = 22;
const PLAYER_SPEED = 270;        // px/s
const PLAYER_HP = 100;
const BULLET_SPEED = 780;
const BULLET_R = 6;
const BULLET_DMG = 20;
const BULLET_KB = 540;           // knockback impulse from a bullet
const BULLET_STUN = 270;         // stun ms from a bullet -> combos
const BULLET_LIFE = 1100;        // ms
const FIRE_COOLDOWN = 240;       // ms
const RESPAWN_MS = 3000;
const KB_DECAY = 5.5;            // exponential decay rate of knockback velocity
const REGEN_DELAY = 4000;        // ms out of combat before regen starts
const REGEN_RATE = 22;           // hp/s
const SPAWN_INVULN = 1800;       // ms of spawn protection (ends early if you shoot)
const GEM_R = 13;
const GEM_SPAWN_MS = 4200;       // slower spawns -> longer rounds
const GEM_MAX_LOOSE = 11;        // fewer gems on the floor
const WIN_GEMS = 10;
const COUNTDOWN_MS = 10000;
const END_SCREEN_MS = 6000;      // winner screen, then everyone back to the party
const MIN_PLAYERS_TO_CONTINUE = 2;
const MAX_PLAYERS = 10;

// ---- abilities (all free, cooldown-gated, tuned as sidegrades) ----
const ABILITIES = {
  dash:   { cd: 2500 },                  // speed burst
  blast:  { cd: 5000 },                  // lobbed bomb, flies over walls
  shield: { cd: 6000, dur: 1500 },       // blocks bullets & bombs; usable while stunned
  ghost:  { cd: 7000, dur: 2500 },       // near-invisible + faster; shooting reveals you
};
const DASH_SPEED = 950;
const BOMB_SPEED = 520;
const BOMB_FLIGHT = 750;         // ms in the air
const BOMB_RADIUS = 130;
const BOMB_DMG = 35;
const BOMB_KB = 700;
const BOMB_STUN = 400;
const GHOST_SPEED_MULT = 1.25;

// ---------------- helpers ----------------
const now = () => Date.now();
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dist2 = (ax, ay, bx, by) => (ax - bx) ** 2 + (ay - by) ** 2;

function circleHitsWall(x, y, r) {
  for (const w of WALLS) {
    const cx = clamp(x, w.x, w.x + w.w);
    const cy = clamp(y, w.y, w.y + w.h);
    if (dist2(x, y, cx, cy) < r * r) return true;
  }
  return false;
}

function randomCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid confusion
  let code = '';
  for (let i = 0; i < 4; i++) code += letters[Math.floor(Math.random() * letters.length)];
  return code;
}

let nextId = 1;

// ---------------- rooms ----------------
const rooms = new Map(); // code -> room

function createRoom(mode) {
  let code;
  do { code = randomCode(); } while (rooms.has(code));
  const room = {
    code,
    mode: MODES[mode] !== undefined ? mode : 'ffa',
    hostId: null,
    phase: 'lobby',       // 'lobby' (party screen) | 'playing' | 'ended'
    players: new Map(),   // id -> player (the whole party, in-match or not)
    bullets: [],
    bombs: [],
    gems: [],
    events: [],
    nextGemAt: 0,
    countdownEnd: null,
    countdownLeader: null,  // player id (ffa) or 'team0'.. (teams)
    winner: null,
    lastWinner: null,
    resetAt: null,
  };
  room.numTeams = MODES[room.mode];
  rooms.set(code, room);
  return room;
}

function spawnGem(room, x, y) {
  // keep gems inside world and out of walls
  let gx = clamp(x, GEM_R + 10, WORLD.w - GEM_R - 10);
  let gy = clamp(y, GEM_R + 10, WORLD.h - GEM_R - 10);
  for (let tries = 0; tries < 12 && circleHitsWall(gx, gy, GEM_R); tries++) {
    gx = clamp(gx + (Math.random() - 0.5) * 120, GEM_R + 10, WORLD.w - GEM_R - 10);
    gy = clamp(gy + (Math.random() - 0.5) * 120, GEM_R + 10, WORLD.h - GEM_R - 10);
  }
  room.gems.push({ id: nextId++, x: Math.round(gx), y: Math.round(gy) });
}

function spawnGemInMine(room) {
  const ang = Math.random() * Math.PI * 2;
  const rad = Math.random() * 300;
  spawnGem(room, WORLD.w / 2 + Math.cos(ang) * rad, WORLD.h / 2 + Math.sin(ang) * rad);
}

// spawn as far from living enemies as possible, restricted to the team's side in team modes
function pickSpawnPoint(room, forPlayer) {
  let candidates = SPAWN_POINTS;
  if (room.mode !== 'ffa' && forPlayer && forPlayer.team >= 0) {
    const idxs = TEAM_SPAWNS[room.mode][forPlayer.team];
    candidates = idxs.map(i => SPAWN_POINTS[i]);
  }
  let best = candidates[0], bestScore = -1;
  for (const sp of candidates) {
    let minD = Infinity;
    for (const p of room.players.values()) {
      if (p === forPlayer || p.dead || !p.playing) continue;
      if (room.mode !== 'ffa' && forPlayer && p.team === forPlayer.team) continue;
      minD = Math.min(minD, dist2(sp.x, sp.y, p.x, p.y));
    }
    const score = minD === Infinity ? Math.random() * 1e12 : minD;
    if (score > bestScore) { bestScore = score; best = sp; }
  }
  return best;
}

function smallestTeam(room) {
  const counts = new Array(room.numTeams).fill(0);
  for (const p of room.players.values()) if (p.team >= 0) counts[p.team]++;
  let best = 0;
  for (let i = 1; i < counts.length; i++) if (counts[i] < counts[best]) best = i;
  return best;
}

function addPlayer(room, ws, name, color, ability) {
  const team = room.mode === 'ffa' ? -1 : smallestTeam(room);
  const prefColor = /^#[0-9a-fA-F]{6}$/.test(String(color)) ? color : '#4dc3ff';
  const player = {
    id: nextId++,
    ws,
    name: String(name || 'Player').slice(0, 14) || 'Player',
    prefColor,
    color: team >= 0 ? TEAM_COLORS[team] : prefColor,
    team,
    ability: ABILITIES[ability] ? ability : 'dash',
    playing: false,               // sits in the party screen until a match starts
    x: 0, y: 0,
    hp: PLAYER_HP,
    gems: 0, kills: 0, deaths: 0,
    dead: false, respawnAt: 0, lastFire: 0,
    kvx: 0, kvy: 0,               // knockback/dash velocity
    stunnedUntil: 0,
    lastHitAt: 0,
    abilityReadyAt: 0,
    shieldUntil: 0,
    ghostUntil: 0,
    invulnUntil: 0,
    dc: null, dcOpen: false,   // WebRTC data channel (UDP game traffic)
    lastActSeq: 0,    // last ability activation processed (dedupe across channels)
    lastInputTs: 0,   // client timestamp of the last processed input (echoed back for reconciliation)
    input: { up: false, down: false, left: false, right: false, fire: false, aim: 0 },
  };
  room.players.set(player.id, player);
  return player;
}

function sameTeam(room, a, b) {
  return room.mode !== 'ffa' && a >= 0 && a === b;
}

function dropGems(room, player) {
  const n = player.gems;
  for (let i = 0; i < n; i++) {
    const ang = (i / Math.max(n, 1)) * Math.PI * 2 + Math.random();
    const rad = 40 + Math.random() * 70;
    spawnGem(room, player.x + Math.cos(ang) * rad, player.y + Math.sin(ang) * rad);
  }
  player.gems = 0;
}

// ---------------- match lifecycle ----------------
function startMatch(room) {
  const t = now();
  room.phase = 'playing';
  room.bullets = [];
  room.bombs = [];
  room.gems = [];
  room.nextGemAt = t + 1500;
  room.countdownEnd = null;
  room.countdownLeader = null;
  room.winner = null;
  room.resetAt = null;
  for (const p of room.players.values()) {
    p.playing = true;
    p.hp = PLAYER_HP; p.gems = 0; p.kills = 0; p.deaths = 0;
    p.dead = false;
    p.kvx = 0; p.kvy = 0;
    p.stunnedUntil = 0; p.lastHitAt = 0;
    p.abilityReadyAt = 0; p.shieldUntil = 0; p.ghostUntil = 0;
    p.invulnUntil = t + SPAWN_INVULN;
    const sp = pickSpawnPoint(room, p);
    p.x = sp.x; p.y = sp.y;
  }
  room.events.push({ e: 'start' });
}

function endMatchToLobby(room, reason) {
  room.phase = 'lobby';
  room.bullets = [];
  room.bombs = [];
  room.gems = [];
  room.countdownEnd = null;
  room.countdownLeader = null;
  room.winner = null;
  room.resetAt = null;
  for (const p of room.players.values()) {
    p.playing = false;
    p.dead = false;
    p.gems = 0;
  }
  if (reason) room.events.push({ e: 'info', msg: reason });
}

// a playing player leaves the match (button or disconnect)
function handleMatchLeave(room, player, viaDisconnect) {
  if (room.phase !== 'playing' || !player.playing) return;
  if (!player.dead) dropGems(room, player);
  player.playing = false;
  player.dead = false;
  player.gems = 0;
  if (!viaDisconnect) room.events.push({ e: 'leftMatch', name: player.name });

  const stillPlaying = [...room.players.values()].filter(p => p.playing).length;
  if (player.id === room.hostId) {
    endMatchToLobby(room, 'Host ended the match — back to the party');
  } else if (stillPlaying < MIN_PLAYERS_TO_CONTINUE) {
    endMatchToLobby(room, 'Not enough players left — back to the party');
  }
}

// move a player by (vx, vy) for dt seconds with wall collision;
// kills knockback velocity on the axis that hits a wall
function moveWithCollision(p, vx, vy, dt) {
  const nx = clamp(p.x + vx * dt, PLAYER_R, WORLD.w - PLAYER_R);
  if (!circleHitsWall(nx, p.y, PLAYER_R)) p.x = nx; else p.kvx = 0;
  const ny = clamp(p.y + vy * dt, PLAYER_R, WORLD.h - PLAYER_R);
  if (!circleHitsWall(p.x, ny, PLAYER_R)) p.y = ny; else p.kvy = 0;
}

// shared damage path for bullets and bombs: hp, knockback, stun, death
function damagePlayer(room, p, dmg, ang, kb, stunMs, killerId, t) {
  p.hp -= dmg;
  p.lastHitAt = t;
  p.kvx = Math.cos(ang) * kb;
  p.kvy = Math.sin(ang) * kb;
  p.stunnedUntil = t + stunMs;
  room.events.push({ e: 'hit', x: p.x, y: p.y, id: p.id, dmg });
  if (p.hp <= 0) {
    const killer = room.players.get(killerId);
    p.dead = true;
    p.deaths++;
    p.respawnAt = t + RESPAWN_MS;
    if (killer) killer.kills++;
    room.events.push({
      e: 'death', x: p.x, y: p.y, id: p.id,
      killer: killer ? killer.name : '???', victim: p.name,
    });
    dropGems(room, p);
  }
}

// ---------------- win condition ----------------
function updateWinCondition(room, t) {
  let winnerName = null;

  if (room.mode === 'ffa') {
    // individual: hold WIN_GEMS through the countdown
    let leader = null;
    for (const p of room.players.values()) {
      if (p.playing && !p.dead && p.gems >= WIN_GEMS && (!leader || p.gems > leader.gems)) leader = p;
    }
    if (leader) {
      if (room.countdownLeader !== leader.id) {
        room.countdownLeader = leader.id;
        room.countdownEnd = t + COUNTDOWN_MS;
      } else if (t >= room.countdownEnd) {
        winnerName = leader.name;
      }
    } else {
      room.countdownLeader = null;
      room.countdownEnd = null;
    }
  } else {
    // teams: combined gems >= WIN_GEMS *and* strictly ahead of every other team.
    // if another team ties the top count, the countdown cancels until someone
    // is uniquely in the lead again (then it restarts fresh).
    const totals = new Array(room.numTeams).fill(0);
    for (const p of room.players.values()) {
      if (p.playing && !p.dead && p.team >= 0) totals[p.team] += p.gems;
    }
    const max = Math.max(...totals);
    const teamsAtMax = totals.filter(v => v === max).length;

    if (max >= WIN_GEMS && teamsAtMax === 1) {
      const teamIdx = totals.indexOf(max);
      const key = 'team' + teamIdx;
      if (room.countdownLeader !== key) {
        room.countdownLeader = key;
        room.countdownEnd = t + COUNTDOWN_MS;
      } else if (t >= room.countdownEnd) {
        winnerName = TEAM_NAMES[teamIdx] + ' TEAM';
      }
    } else {
      room.countdownLeader = null;
      room.countdownEnd = null;
    }
  }

  if (winnerName) {
    room.phase = 'ended';
    room.winner = winnerName;
    room.lastWinner = winnerName;
    room.resetAt = t + END_SCREEN_MS;
    room.events.push({ e: 'win', winner: winnerName });
  }
}

// ---------------- game tick ----------------
function tickRoom(room) {
  const t = now();
  const dt = TICK_MS / 1000;

  if (room.phase === 'lobby') {
    // party screen doesn't need 30 updates/s - saves CPU/bandwidth on small hosts
    flushEvents(room);
    room.lobbyBcast = (room.lobbyBcast || 0) + 1;
    if (room.lobbyBcast % 6 === 0) broadcast(room, true);
    return;
  }

  if (room.phase === 'ended') {
    if (t >= room.resetAt) endMatchToLobby(room, null);
    flushEvents(room);
    broadcast(room, true);
    return;
  }

  // spawn gems in the central mine
  if (t >= room.nextGemAt && room.gems.length < GEM_MAX_LOOSE) {
    spawnGemInMine(room);
    room.nextGemAt = t + GEM_SPAWN_MS;
  }

  // --- players: respawn, move, regen, pick up gems, fire ---
  for (const p of room.players.values()) {
    if (!p.playing) continue;
    if (p.dead) {
      if (t >= p.respawnAt) {
        const sp = pickSpawnPoint(room, p);
        p.x = sp.x; p.y = sp.y; p.hp = PLAYER_HP; p.dead = false;
        p.kvx = 0; p.kvy = 0; p.stunnedUntil = 0;
        p.shieldUntil = 0; p.ghostUntil = 0;
        p.invulnUntil = t + SPAWN_INVULN;
      } else continue;
    }

    // input movement - blocked while stunned (knockback combos!)
    let ivx = 0, ivy = 0;
    if (t >= p.stunnedUntil) {
      let dx = (p.input.right ? 1 : 0) - (p.input.left ? 1 : 0);
      let dy = (p.input.down ? 1 : 0) - (p.input.up ? 1 : 0);
      if (dx || dy) {
        const len = Math.hypot(dx, dy);
        let speed = PLAYER_SPEED * (1 - Math.min(p.gems, 10) * 0.02); // gems slow you down
        if (t < p.ghostUntil) speed *= GHOST_SPEED_MULT;
        ivx = (dx / len) * speed;
        ivy = (dy / len) * speed;
      }
    }

    // knockback / dash velocity decays exponentially
    const decay = Math.exp(-KB_DECAY * dt);
    p.kvx *= decay; p.kvy *= decay;
    if (Math.abs(p.kvx) < 8) p.kvx = 0;
    if (Math.abs(p.kvy) < 8) p.kvy = 0;

    moveWithCollision(p, ivx + p.kvx, ivy + p.kvy, dt);

    // out-of-combat regen
    if (p.hp < PLAYER_HP && t - p.lastHitAt > REGEN_DELAY) {
      p.hp = Math.min(PLAYER_HP, p.hp + REGEN_RATE * dt);
    }

    // gem pickup
    for (let i = room.gems.length - 1; i >= 0; i--) {
      const g = room.gems[i];
      if (dist2(p.x, p.y, g.x, g.y) < (PLAYER_R + GEM_R) ** 2) {
        room.gems.splice(i, 1);
        p.gems++;
        room.events.push({ e: 'pickup', x: g.x, y: g.y, id: p.id });
      }
    }

    // shooting (allowed while stunned - you can fight back mid-combo)
    if (p.input.fire && t - p.lastFire >= FIRE_COOLDOWN) {
      p.lastFire = t;
      p.invulnUntil = 0;  // shooting drops your spawn shield
      p.ghostUntil = 0;   // ...and reveals you if ghosted
      const a = p.input.aim;
      room.bullets.push({
        id: nextId++,
        x: p.x + Math.cos(a) * (PLAYER_R + BULLET_R + 2),
        y: p.y + Math.sin(a) * (PLAYER_R + BULLET_R + 2),
        vx: Math.cos(a) * BULLET_SPEED,
        vy: Math.sin(a) * BULLET_SPEED,
        owner: p.id, team: p.team, color: p.color, dieAt: t + BULLET_LIFE,
      });
      room.events.push({ e: 'shoot', x: p.x, y: p.y, id: p.id, a });
    }
  }

  // --- bullets ---
  for (let i = room.bullets.length - 1; i >= 0; i--) {
    const b = room.bullets[i];
    b.x += b.vx * dt;
    b.y += b.vy * dt;

    let dead = t >= b.dieAt ||
      b.x < 0 || b.x > WORLD.w || b.y < 0 || b.y > WORLD.h ||
      circleHitsWall(b.x, b.y, BULLET_R);

    if (!dead) {
      for (const p of room.players.values()) {
        if (!p.playing || p.dead || p.id === b.owner) continue;
        if (sameTeam(room, b.team, p.team)) continue;  // no friendly fire, shots pass through
        if (t < p.invulnUntil) continue;               // spawn protection
        if (dist2(b.x, b.y, p.x, p.y) < (PLAYER_R + BULLET_R) ** 2) {
          dead = true;
          if (t < p.shieldUntil) {
            room.events.push({ e: 'block', x: b.x, y: b.y, id: p.id });
          } else {
            damagePlayer(room, p, BULLET_DMG, Math.atan2(b.vy, b.vx), BULLET_KB, BULLET_STUN, b.owner, t);
          }
          break;
        }
      }
    }
    if (dead) room.bullets.splice(i, 1);
  }

  // --- bombs (fly over walls, explode on a timer) ---
  for (let i = room.bombs.length - 1; i >= 0; i--) {
    const b = room.bombs[i];
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    if (t >= b.explodeAt) {
      room.bombs.splice(i, 1);
      room.events.push({ e: 'boom', x: b.x, y: b.y, r: BOMB_RADIUS });
      for (const p of room.players.values()) {
        if (!p.playing || p.dead || p.id === b.owner) continue;
        if (sameTeam(room, b.team, p.team)) continue;
        if (t < p.invulnUntil || t < p.shieldUntil) continue;
        if (dist2(b.x, b.y, p.x, p.y) < (BOMB_RADIUS + PLAYER_R) ** 2) {
          const ang = Math.atan2(p.y - b.y, p.x - b.x);
          damagePlayer(room, p, BOMB_DMG, ang, BOMB_KB, BOMB_STUN, b.owner, t);
        }
      }
    }
  }

  updateWinCondition(room, t);

  // events reliably every tick; snapshots 30Hz over UDP, 15Hz over WS fallback
  flushEvents(room);
  room.bcastTick = (room.bcastTick || 0) + 1;
  broadcast(room, room.bcastTick % 2 === 0);
}

// apply an input packet; guards against stale out-of-order UDP packets
function applyInput(room, player, msg) {
  // ability activations are checked BEFORE the staleness guard: they ride
  // several packets on both channels and are deduped by sequence number,
  // so a slow reliable channel can never make them "stale"
  if (msg.act && Number(msg.act) > player.lastActSeq) {
    player.lastActSeq = Number(msg.act);
    activateAbility(room, player, msg, now());
  }
  if (Number.isFinite(msg.ts)) {
    if (msg.ts < player.lastInputTs) return;  // older than what we already have
    player.lastInputTs = msg.ts;
  }
  player.input.up = !!msg.up;
  player.input.down = !!msg.down;
  player.input.left = !!msg.left;
  player.input.right = !!msg.right;
  player.input.fire = !!msg.fire;
  player.input.aim = Number(msg.aim) || 0;
}

// ---------------- ability activation ----------------
function activateAbility(room, p, msg, t) {
  if (!p.playing || p.dead || room.phase !== 'playing' || t < p.abilityReadyAt) return;
  const kind = p.ability;

  // movement abilities can't break a stun; shield & blast CAN be used mid-combo
  if ((kind === 'dash' || kind === 'ghost') && t < p.stunnedUntil) return;

  if (kind === 'dash') {
    const dx = (msg.right ? 1 : 0) - (msg.left ? 1 : 0);
    const dy = (msg.down ? 1 : 0) - (msg.up ? 1 : 0);
    const a = (dx || dy) ? Math.atan2(dy, dx) : p.input.aim;
    p.kvx = Math.cos(a) * DASH_SPEED;
    p.kvy = Math.sin(a) * DASH_SPEED;
  }
  else if (kind === 'blast') {
    const a = p.input.aim;
    room.bombs.push({
      id: nextId++,
      x: p.x, y: p.y,
      vx: Math.cos(a) * BOMB_SPEED,
      vy: Math.sin(a) * BOMB_SPEED,
      owner: p.id, team: p.team,
      explodeAt: t + BOMB_FLIGHT,
    });
  }
  else if (kind === 'shield') {
    p.shieldUntil = t + ABILITIES.shield.dur;
  }
  else if (kind === 'ghost') {
    p.ghostUntil = t + ABILITIES.ghost.dur;
  }

  p.abilityReadyAt = t + ABILITIES[kind].cd;
  room.events.push({ e: 'ability', kind, x: p.x, y: p.y, id: p.id });
}

// ---------------- networking ----------------
// events (shots, hits, deaths, joins...) must never be lost -> always reliable WS
function flushEvents(room) {
  if (!room.events.length) return;
  const msg = JSON.stringify({ t: 'events', events: room.events });
  room.events = [];
  for (const p of room.players.values()) {
    if (p.ws.readyState === 1) p.ws.send(msg);
  }
}

// snapshots are disposable: UDP data channel when open (30Hz), WS fallback (15Hz)
function broadcast(room, includeWsClients) {
  const t = now();
  room.seq = (room.seq || 0) + 1;
  const msg = JSON.stringify({
    t: 'state',
    seq: room.seq,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, color: p.color, ab: p.ability, tm: p.team,
      playing: p.playing,
      x: Math.round(p.x), y: Math.round(p.y),
      hp: Math.round(p.hp), gems: p.gems, kills: p.kills, deaths: p.deaths,
      dead: p.dead, respawnIn: p.dead ? Math.max(0, p.respawnAt - t) : 0,
      st: Math.max(0, p.stunnedUntil - t),                    // stun ms remaining
      kvx: Math.round(p.kvx), kvy: Math.round(p.kvy),         // knockback velocity (for prediction)
      inv: t < p.invulnUntil,                                 // spawn shield
      sh: Math.max(0, p.shieldUntil - t),                     // ability shield ms remaining
      gh: Math.max(0, p.ghostUntil - t),                      // ghost ms remaining
      abIn: Math.max(0, p.abilityReadyAt - t),                // ability cooldown remaining
      ets: p.lastInputTs,                                     // input timestamp echo (reconciliation)
    })),
    bullets: room.bullets.map(b => ({ id: b.id, x: Math.round(b.x), y: Math.round(b.y), color: b.color })),
    bombs: room.bombs.map(b => ({ id: b.id, x: Math.round(b.x), y: Math.round(b.y), fuse: Math.max(0, b.explodeAt - t) })),
    gems: room.gems.map(g => ({ id: g.id, x: g.x, y: g.y })),
    status: {
      phase: room.phase,
      mode: room.mode,
      hostId: room.hostId,
      winner: room.winner,
      lastWinner: room.lastWinner,
      leaderId: room.mode === 'ffa' ? room.countdownLeader : null,
      leaderTeam: room.mode !== 'ffa' && room.countdownLeader ? Number(String(room.countdownLeader).slice(4)) : null,
      countdown: room.countdownEnd ? Math.max(0, room.countdownEnd - t) : null,
      resetIn: room.resetAt ? Math.max(0, room.resetAt - t) : null,
    },
  });
  for (const p of room.players.values()) {
    if (p.dcOpen && p.dc) {
      try { p.dc.sendMessage(msg); } catch { p.dcOpen = false; }
    } else if (includeWsClients && p.ws.readyState === 1) {
      p.ws.send(msg);
    }
  }
}

// compression off: costs CPU we don't have on small hosts and adds latency
const wss = new WebSocketServer({ server, perMessageDeflate: false });

wss.on('connection', (ws) => {
  // TCP_NODELAY: never batch our small, frequent packets (Nagle causes 40-200ms bursts)
  if (ws._socket && ws._socket.setNoDelay) ws._socket.setNoDelay(true);

  let room = null;
  let player = null;
  let pc = null;   // WebRTC peer connection for this client

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // instant echo for true RTT measurement - not tied to the tick loop
    if (msg.t === 'ping') {
      if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'pong', ts: msg.ts }));
      return;
    }

    if (msg.t === 'create' && !player) {
      room = createRoom(msg.mode);
      player = addPlayer(room, ws, msg.name, msg.color, msg.ability);
      room.hostId = player.id;
      ws.send(JSON.stringify({ t: 'joined', code: room.code, id: player.id, mode: room.mode, world: WORLD, walls: WALLS, winGems: WIN_GEMS }));
    }
    else if (msg.t === 'join' && !player) {
      const code = String(msg.code || '').toUpperCase().trim();
      const r = rooms.get(code);
      if (!r) return ws.send(JSON.stringify({ t: 'error', msg: `Room "${code}" not found` }));
      if (r.players.size >= MAX_PLAYERS) return ws.send(JSON.stringify({ t: 'error', msg: 'Room is full (10 players max)' }));
      room = r;
      player = addPlayer(room, ws, msg.name, msg.color, msg.ability);
      ws.send(JSON.stringify({ t: 'joined', code: room.code, id: player.id, mode: room.mode, world: WORLD, walls: WALLS, winGems: WIN_GEMS }));
      room.events.push({ e: 'join', name: player.name });
    }
    else if (!player || !room) return;

    else if (msg.t === 'input') {
      applyInput(room, player, msg);
    }
    // ---- WebRTC signaling: client offers, we answer; game traffic then flows over UDP ----
    else if (msg.t === 'rtc-offer' && ndc && !pc) {
      try {
        pc = new ndc.PeerConnection('c' + player.id, { iceServers: STUN });
        pc.onLocalDescription((sdp, type) => {
          if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'rtc-answer', sdp, type }));
        });
        pc.onLocalCandidate((candidate, mid) => {
          if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'rtc-ice', candidate, mid }));
        });
        const boundPlayer = player, boundRoom = room;
        pc.onDataChannel((dc) => {
          boundPlayer.dc = dc;
          boundPlayer.dcOpen = true;
          dc.onMessage((data) => {
            let m;
            try { m = JSON.parse(data.toString()); } catch { return; }
            if (m.t === 'ping') { try { dc.sendMessage(JSON.stringify({ t: 'pong', ts: m.ts })); } catch {} }
            else if (m.t === 'input') applyInput(boundRoom, boundPlayer, m);
          });
          dc.onClosed(() => { boundPlayer.dcOpen = false; boundPlayer.dc = null; });
        });
        pc.setRemoteDescription(msg.sdp, 'offer');
      } catch (e) {
        console.log('rtc setup failed:', e.message);
        pc = null;
      }
    }
    else if (msg.t === 'rtc-ice' && pc) {
      try { pc.addRemoteCandidate(msg.candidate, msg.mid); } catch {}
    }
    // ---- party screen actions (lobby phase only) ----
    else if (msg.t === 'profile' && room.phase === 'lobby') {
      if (typeof msg.name === 'string' && msg.name.trim()) player.name = msg.name.trim().slice(0, 14);
      if (typeof msg.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(msg.color)) player.prefColor = msg.color;
      if (ABILITIES[msg.ability]) player.ability = msg.ability;
      if (room.mode === 'ffa') player.color = player.prefColor;
    }
    else if (msg.t === 'setMode' && room.phase === 'lobby' && player.id === room.hostId && MODES[msg.mode] !== undefined) {
      room.mode = msg.mode;
      room.numTeams = MODES[msg.mode];
      // rebalance everyone onto teams (or back to personal colors in ffa)
      let i = 0;
      for (const p of room.players.values()) {
        if (room.mode === 'ffa') {
          p.team = -1;
          p.color = p.prefColor;
        } else {
          p.team = i % room.numTeams;
          p.color = TEAM_COLORS[p.team];
          i++;
        }
      }
      room.events.push({ e: 'mode', mode: room.mode });
    }
    else if (msg.t === 'setTeam' && room.phase === 'lobby' && room.mode !== 'ffa' && player.id === room.hostId) {
      // host-only, party screen only: cycle a player to the next team
      const target = room.players.get(Number(msg.id));
      if (target && target.team >= 0) {
        target.team = (target.team + 1) % room.numTeams;
        target.color = TEAM_COLORS[target.team];
        room.events.push({ e: 'team', name: target.name, team: target.team });
      }
    }
    else if (msg.t === 'start' && room.phase === 'lobby' && player.id === room.hostId) {
      startMatch(room);
    }
    else if (msg.t === 'leaveMatch') {
      handleMatchLeave(room, player, false);
    }
  });

  ws.on('close', () => {
    if (pc) { try { pc.close(); } catch {} pc = null; }
    if (player) { player.dcOpen = false; player.dc = null; }
    if (room && player) {
      handleMatchLeave(room, player, true);
      room.players.delete(player.id);
      room.events.push({ e: 'leave', name: player.name });
      if (room.players.size === 0) {
        rooms.delete(room.code);
      } else if (room.hostId === player.id) {
        room.hostId = room.players.keys().next().value;  // pass host to next player
        const newHost = room.players.get(room.hostId);
        if (newHost) room.events.push({ e: 'info', msg: `${newHost.name} is now the party host` });
      }
    }
  });
});

setInterval(() => {
  for (const room of rooms.values()) tickRoom(room);
}, TICK_MS);

server.listen(PORT, () => {
  console.log('');
  console.log('  ============================================');
  console.log('   GEM RUSH server running!');
  console.log(`   Play at:  http://localhost:${PORT}`);
  console.log('   Friends on your wifi: use your LAN IP');
  console.log('   (run "ipconfig" and look for IPv4 Address)');
  console.log('  ============================================');
  console.log('');
});
