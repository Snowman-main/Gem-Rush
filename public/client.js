// ============================================================
//  GEM RUSH - client
//  Screens: home -> party (lobby) -> game -> back to party.
//  Smooth movement: local prediction for YOUR player (60+ fps),
//  buffered interpolation for everyone else.
// ============================================================
'use strict';

// ---------------- DOM ----------------
const $ = (id) => document.getElementById(id);
const homeEl = $('home'), partyEl = $('party'), gameEl = $('game'), canvas = $('canvas');
const ctx = canvas.getContext('2d');

const COLORS = ['#4dc3ff', '#ff5c9e', '#8fce4e', '#ffb938', '#ff7847', '#b07fff', '#e8563f', '#4ee0b8'];

// physics constants mirrored from server.js - keep in sync
const PLAYER_R = 22;
const PLAYER_SPEED = 270;
const KB_DECAY = 5.5;
const GHOST_SPEED_MULT = 1.25;
const INTERP_DELAY = 120;   // ms behind live for other players (smooths jitter)

const ABILITY_DEFS = {
  dash:   { icon: '⚡', name: 'Dash',   cd: 2500, desc: 'Quick burst of speed. Dodge, chase, escape.' },
  blast:  { icon: '💣', name: 'Blast',  cd: 5000, desc: 'Lob a bomb over walls. Big knockback boom.' },
  shield: { icon: '🛡️', name: 'Shield', cd: 6000, desc: 'Block everything for 1.5s. Works while stunned!' },
  ghost:  { icon: '👻', name: 'Ghost',  cd: 7000, desc: 'Near-invisible + faster for 2.5s. Shooting reveals you.' },
};

// mirrored from server.js
const TEAM_NAMES = ['RED', 'BLUE', 'GREEN', 'PURPLE'];
const TEAM_COLORS = ['#e8563f', '#4dc3ff', '#8fce4e', '#b07fff'];
const MODE_DEFS = {
  ffa:    { name: 'Free-for-all', desc: 'Everyone for themselves' },
  teams2: { name: '2 Teams',      desc: 'Red vs Blue' },
  teams4: { name: '4 Teams',      desc: 'Red, Blue, Green, Purple' },
};

// ---------------- state ----------------
let ws = null;
let myId = null;
let world = { w: 2400, h: 1800 };
let walls = [];
let winGems = 10;
let roomMode = 'ffa';
let hostId = null;
let inMatch = false;      // am I inside a running match right now?
let leftOnPurpose = false;

let snaps = [];           // interpolation buffer: {t: perfNow, msg}
let latest = null;        // newest state msg

// local prediction of my own player
const pred = { x: 0, y: 0, kvx: 0, kvy: 0, stunUntil: 0, ghostUntil: 0, init: false };
let serverPos = null;     // last authoritative position of me
let actPending = false;   // ability keypress waiting to be sent
let abilityCdEnd = 0;     // perfNow when my ability is ready (from server)

let particles = [];
let dmgTexts = [];                // floating damage numbers
const hitFlashes = new Map();     // playerId -> perfNow of last hit (white flash)
const bulletTrails = new Map();   // bulletId -> last drawn pos
let shake = 0;
let redFlash = 0;                 // screen vignette intensity from taking damage

const input = { up: false, down: false, left: false, right: false, fire: false, aim: 0 };
const mouse = { x: 0, y: 0 };

// ---------------- my profile (persisted) ----------------
let myColor = localStorage.getItem('gemrush-color') || COLORS[Math.floor(Math.random() * COLORS.length)];
if (!COLORS.includes(myColor)) myColor = COLORS[0];
let myAbility = localStorage.getItem('gemrush-ability') || 'dash';
if (!ABILITY_DEFS[myAbility]) myAbility = 'dash';
$('nameInput').value = localStorage.getItem('gemrush-name') || '';

function myName() { return ($('partyName').value || $('nameInput').value).trim() || 'Player'; }

function sendProfile() {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ t: 'profile', name: myName(), color: myColor, ability: myAbility }));
  }
  localStorage.setItem('gemrush-name', myName());
  localStorage.setItem('gemrush-color', myColor);
  localStorage.setItem('gemrush-ability', myAbility);
}

// ---------------- party screen widgets ----------------
const colorRow = $('colorRow');
for (const c of COLORS) {
  const sw = document.createElement('div');
  sw.className = 'swatch' + (c === myColor ? ' selected' : '');
  sw.style.background = c;
  sw.onclick = () => {
    myColor = c;
    document.querySelectorAll('.swatch').forEach(s => s.classList.remove('selected'));
    sw.classList.add('selected');
    sendProfile();
  };
  colorRow.appendChild(sw);
}

const abilityRow = $('abilityRow');
for (const [key, def] of Object.entries(ABILITY_DEFS)) {
  const card = document.createElement('div');
  card.className = 'ability-card' + (key === myAbility ? ' selected' : '');
  card.innerHTML = `<div class="ability-name"></div><div class="ability-desc"></div><div class="ability-cd"></div>`;
  card.querySelector('.ability-name').textContent = `${def.icon} ${def.name}`;
  card.querySelector('.ability-desc').textContent = def.desc;
  card.querySelector('.ability-cd').textContent = `${(def.cd / 1000).toFixed(1)}s cooldown`;
  card.onclick = () => {
    myAbility = key;
    document.querySelectorAll('.ability-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    sendProfile();
  };
  abilityRow.appendChild(card);
}

const modeRow = $('modeRow');
const modeBtns = {};
for (const [key, def] of Object.entries(MODE_DEFS)) {
  const btn = document.createElement('div');
  btn.className = 'mode-btn';
  btn.innerHTML = `<div class="mode-name"></div><div class="mode-desc"></div>`;
  btn.querySelector('.mode-name').textContent = def.name;
  btn.querySelector('.mode-desc').textContent = def.desc;
  btn.onclick = () => {
    if (hostId === myId && ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'setMode', mode: key }));
  };
  modeBtns[key] = btn;
  modeRow.appendChild(btn);
}

$('partyName').addEventListener('change', sendProfile);

// ---------------- screens ----------------
function showScreen(name) {
  homeEl.classList.toggle('hidden', name !== 'home');
  partyEl.classList.toggle('hidden', name !== 'party');
  gameEl.classList.toggle('hidden', name !== 'game');
}

// ---------------- audio (synthesized, no assets) ----------------
let audioCtx = null;
function sfx(freq, dur, type = 'square', vol = 0.15, slide = 0) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + dur);
  } catch { /* audio blocked until user gesture - fine */ }
}
const sndShoot  = (v) => sfx(300, 0.09, 'square', v, -160);
const sndHit    = (v) => sfx(140, 0.12, 'sawtooth', v, -60);
const sndPickup = () => { sfx(880, 0.07, 'sine', 0.14); setTimeout(() => sfx(1320, 0.09, 'sine', 0.12), 60); };
const sndDeath  = () => sfx(320, 0.5, 'sawtooth', 0.2, -280);
const sndDash   = (v) => sfx(160, 0.22, 'sawtooth', v, 420);
const sndBoom   = (v) => { sfx(90, 0.4, 'sawtooth', v, -55); sfx(55, 0.5, 'square', v * 0.8, -25); };
const sndShield = (v) => sfx(440, 0.25, 'triangle', v, 300);
const sndBlock  = (v) => sfx(700, 0.08, 'triangle', v, 200);
const sndGhost  = (v) => sfx(500, 0.35, 'sine', v, -350);
const sndTick   = () => sfx(1000, 0.06, 'sine', 0.1);
const sndStart  = () => { [392, 523, 659].forEach((f, i) => setTimeout(() => sfx(f, 0.18, 'triangle', 0.16), i * 110)); };
const sndWin    = () => { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => sfx(f, 0.25, 'triangle', 0.18), i * 130)); };

// ---------------- helpers ----------------
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;

function circleHitsWall(x, y, r) {
  for (const w of walls) {
    const cx = clamp(x, w.x, w.x + w.w);
    const cy = clamp(y, w.y, w.y + w.h);
    if ((x - cx) ** 2 + (y - cy) ** 2 < r * r) return true;
  }
  return false;
}

function meLatest() { return latest ? latest.players.find(p => p.id === myId) : null; }

// ---------------- networking ----------------
function connect(onOpen) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = onOpen;
  ws.onmessage = (ev) => handleMessage(JSON.parse(ev.data));
  ws.onclose = () => {
    inMatch = false;
    latest = null;
    showScreen('home');
    if (!leftOnPurpose) $('lobbyError').textContent = 'Disconnected from server.';
    leftOnPurpose = false;
  };
}

function enterMatchReset() {
  snaps = [];
  pred.init = false;
  particles = [];
  dmgTexts = [];
  bulletTrails.clear();
  hitFlashes.clear();
  shake = 0; redFlash = 0;
  input.up = input.down = input.left = input.right = input.fire = false;
  resize();
}

function handleMessage(msg) {
  if (msg.t === 'joined') {
    myId = msg.id;
    world = msg.world;
    walls = msg.walls;
    winGems = msg.winGems;
    roomMode = msg.mode || 'ffa';
    $('roomCode').textContent = msg.code;
    $('partyCode').textContent = msg.code;
    $('winGems').textContent = winGems;
    $('partyName').value = myName();
    latest = null;
    showScreen('party');
  }
  else if (msg.t === 'error') {
    $('lobbyError').textContent = msg.msg;
    leftOnPurpose = true;
    ws.close();
  }
  else if (msg.t === 'state') {
    const t = performance.now();
    latest = msg;
    roomMode = msg.status.mode;
    hostId = msg.status.hostId;

    const m = meLatest();
    const nowInMatch = !!(m && m.playing && msg.status.phase !== 'lobby');
    if (nowInMatch && !inMatch) { enterMatchReset(); sndStart(); }
    inMatch = nowInMatch;

    if (inMatch) {
      snaps.push({ t, msg });
      if (snaps.length > 15) snaps.shift();

      // adopt authoritative combat state for my player
      if (!pred.init || m.dead) {
        pred.x = m.x; pred.y = m.y;
        pred.kvx = 0; pred.kvy = 0;
        pred.init = true;
      } else {
        pred.kvx = m.kvx; pred.kvy = m.kvy;   // knockback/dash comes from the server
      }
      pred.stunUntil = t + m.st;
      pred.ghostUntil = t + m.gh;
      serverPos = { x: m.x, y: m.y };
      abilityCdEnd = t + m.abIn;

      for (const e of msg.events) handleEvent(e);
      updateHud(msg);
      showScreen('game');
    } else {
      // party screen: only feed-style events matter
      for (const e of msg.events) {
        if (['join', 'leave', 'team', 'mode', 'info', 'leftMatch', 'win'].includes(e.e)) handleEvent(e);
      }
      updateParty(msg);
      showScreen('party');
    }
  }
}

function startGame(mode) {
  const name = myName();
  localStorage.setItem('gemrush-name', name);
  $('lobbyError').textContent = '';
  connect(() => {
    const base = { name, color: myColor, ability: myAbility };
    if (mode === 'create') ws.send(JSON.stringify({ t: 'create', ...base, mode: 'ffa' }));
    else ws.send(JSON.stringify({ t: 'join', code: $('codeInput').value, ...base }));
  });
}

$('createBtn').onclick = () => startGame('create');
$('joinBtn').onclick = () => startGame('join');
$('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') startGame('join'); });
$('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') startGame('create'); });
$('startBtn').onclick = () => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'start' })); };
$('leavePartyBtn').onclick = () => { leftOnPurpose = true; if (ws) ws.close(); };
$('leaveBtn').onclick = () => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'leaveMatch' })); };

function copyCodeTo(btnId) {
  const btn = $(btnId);
  navigator.clipboard.writeText($('partyCode').textContent);
  btn.textContent = '✓';
  setTimeout(() => { btn.textContent = '⧉'; }, 1200);
}
$('copyCode').onclick = () => copyCodeTo('copyCode');
$('partyCopy').onclick = () => copyCodeTo('partyCopy');

function sendInput() {
  if (inMatch && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ t: 'input', ...input, act: actPending }));
    actPending = false;
  }
}
setInterval(sendInput, 33);

// ---------------- party screen rendering ----------------
let partySig = '';

function updateParty(msg) {
  const isHost = hostId === myId;
  const teamMode = roomMode !== 'ffa';
  const nTeams = roomMode === 'teams2' ? 2 : roomMode === 'teams4' ? 4 : 0;
  const lobby = msg.status.phase === 'lobby';

  const sig = JSON.stringify([
    msg.players.map(p => [p.id, p.name, p.color, p.ab, p.tm, p.playing]),
    roomMode, hostId, msg.status.phase, msg.status.lastWinner,
  ]);
  if (sig === partySig) return;
  partySig = sig;

  // banner
  const banner = $('partyBanner');
  if (!lobby) {
    banner.textContent = '⚔ Match in progress — you\'ll be in the next one. Hang tight!';
    banner.classList.remove('hidden');
  } else if (msg.status.lastWinner) {
    banner.textContent = `🏆 Last game: ${msg.status.lastWinner} won!`;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }

  // roster
  const roster = $('partyRoster');
  roster.innerHTML = '';
  $('rosterHint').textContent = isHost && teamMode && lobby ? '— use ⇄ to move players between teams' : '';

  const makeRow = (p) => {
    const row = document.createElement('div');
    row.className = 'roster-row';
    row.innerHTML = `<div class="score-dot"></div><div class="roster-name"></div><div class="roster-tags"></div>`;
    row.querySelector('.score-dot').style.background = p.color;
    row.querySelector('.roster-name').textContent = `${ABILITY_DEFS[p.ab] ? ABILITY_DEFS[p.ab].icon : ''} ${p.name}${p.id === myId ? ' (you)' : ''}`;
    const tags = row.querySelector('.roster-tags');
    if (p.id === hostId) { const s = document.createElement('span'); s.className = 'tag tag-host'; s.textContent = 'HOST'; tags.appendChild(s); }
    if (p.playing) { const s = document.createElement('span'); s.className = 'tag'; s.textContent = 'IN MATCH'; tags.appendChild(s); }
    if (isHost && teamMode && lobby) {
      const btn = document.createElement('button');
      btn.className = 'team-move';
      btn.textContent = '⇄';
      btn.title = 'Move to next team';
      btn.onclick = () => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'setTeam', id: p.id })); };
      tags.appendChild(btn);
    }
    return row;
  };

  if (teamMode) {
    for (let ti = 0; ti < nTeams; ti++) {
      const members = msg.players.filter(p => p.tm === ti);
      const head = document.createElement('div');
      head.className = 'roster-team';
      head.textContent = `${TEAM_NAMES[ti]} TEAM ${members.length ? '' : '(empty)'}`;
      head.style.color = TEAM_COLORS[ti];
      roster.appendChild(head);
      for (const p of members) roster.appendChild(makeRow(p));
    }
  } else {
    for (const p of msg.players) roster.appendChild(makeRow(p));
  }

  // mode buttons
  for (const [key, btn] of Object.entries(modeBtns)) {
    btn.classList.toggle('selected', key === roomMode);
    btn.classList.toggle('disabled', !(isHost && lobby));
  }
  $('modeHint').textContent = isHost ? '— you pick, you\'re the host' : '— only the host can change this';

  // start / waiting
  $('startBtn').classList.toggle('hidden', !(isHost && lobby));
  $('waitingMsg').classList.toggle('hidden', isHost || !lobby);
}

// ---------------- events -> sounds, particles, damage numbers ----------------
function volByDist(x, y, base) {
  if (!pred.init) return base * 0.4;
  const d = Math.hypot(pred.x - x, pred.y - y);
  return base * Math.max(0.08, 1 - d / 1400);
}

function handleEvent(e) {
  if (e.e === 'shoot') {
    sndShoot(volByDist(e.x, e.y, 0.12));
    const mx = e.x + Math.cos(e.a) * (PLAYER_R + 10);
    const my = e.y + Math.sin(e.a) * (PLAYER_R + 10);
    particles.push({ x: mx, y: my, vx: 0, vy: 0, life: 1, decay: 9, size: 9, color: '#fff3d6' });
  }
  else if (e.e === 'hit') {
    sndHit(volByDist(e.x, e.y, 0.2));
    burst(e.x, e.y, 8, '#fff3d6', 3);
    hitFlashes.set(e.id, performance.now());
    dmgTexts.push({ x: e.x, y: e.y - 24, text: '-' + e.dmg, color: '#ff6a50', life: 1 });
    if (e.id === myId) { shake = Math.min(shake + 8, 16); redFlash = Math.min(redFlash + 0.45, 0.8); }
  }
  else if (e.e === 'pickup') {
    if (e.id === myId) sndPickup();
    burst(e.x, e.y, 10, '#ffb938', 2.5);
    dmgTexts.push({ x: e.x, y: e.y - 18, text: '+💎', color: '#ffb938', life: 1 });
  }
  else if (e.e === 'death') {
    sndDeath();
    burst(e.x, e.y, 30, '#e8563f', 5);
    burst(e.x, e.y, 12, '#fff3d6', 3.5);
    if (e.id === myId) { shake = 20; redFlash = 1; }
    addKillFeed(e.killer, e.victim);
  }
  else if (e.e === 'ability') {
    if (e.kind === 'dash') { sndDash(volByDist(e.x, e.y, 0.14)); burst(e.x, e.y, 12, '#fff3d6', 4); }
    else if (e.kind === 'shield') { sndShield(volByDist(e.x, e.y, 0.15)); burst(e.x, e.y, 10, '#6fd4ff', 2.5); }
    else if (e.kind === 'ghost') { sndGhost(volByDist(e.x, e.y, 0.15)); burst(e.x, e.y, 14, '#cfd6e8', 2); }
    else if (e.kind === 'blast') sfx(220, 0.12, 'square', volByDist(e.x, e.y, 0.13), -80);
  }
  else if (e.e === 'boom') {
    sndBoom(volByDist(e.x, e.y, 0.3));
    burst(e.x, e.y, 34, '#ffb938', 6);
    burst(e.x, e.y, 16, '#e8563f', 4);
    particles.push({ x: e.x, y: e.y, vx: 0, vy: 0, life: 1, decay: 2.4, size: e.r, color: '#ffb938', ring: true });
    const d = pred.init ? Math.hypot(pred.x - e.x, pred.y - e.y) : 9999;
    if (d < 500) shake = Math.min(shake + (1 - d / 500) * 16, 20);
  }
  else if (e.e === 'block') {
    sndBlock(volByDist(e.x, e.y, 0.16));
    burst(e.x, e.y, 6, '#6fd4ff', 2.5);
  }
  else if (e.e === 'win') sndWin();
  else if (e.e === 'start') sndStart();
  else if (e.e === 'team') addFeedText(`${e.name} → ${TEAM_NAMES[e.team]} team`);
  else if (e.e === 'mode') addFeedText(`Mode: ${MODE_DEFS[e.mode] ? MODE_DEFS[e.mode].name : e.mode}`);
  else if (e.e === 'info') addFeedText(e.msg);
  else if (e.e === 'leftMatch') addFeedText(`${e.name} left the match`);
  else if (e.e === 'join') addFeedText(`${e.name} joined the party`);
  else if (e.e === 'leave') addFeedText(`${e.name} left`);
}

function burst(x, y, n, color, speed) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = (0.4 + Math.random()) * speed;
    particles.push({
      x, y,
      vx: Math.cos(a) * s * 60, vy: Math.sin(a) * s * 60,
      life: 1, decay: 1.6 + Math.random() * 1.6,
      size: 2 + Math.random() * 3, color,
    });
  }
}

// ---------------- kill feed ----------------
function addKillFeed(killer, victim) {
  const div = document.createElement('div');
  div.className = 'feed-item';
  div.innerHTML = `<span class="k"></span> ⚔ <span class="v"></span>`;
  div.querySelector('.k').textContent = killer;
  div.querySelector('.v').textContent = victim;
  pushFeed(div);
}
function addFeedText(text) {
  const div = document.createElement('div');
  div.className = 'feed-item';
  div.textContent = text;
  pushFeed(div);
}
function pushFeed(div) {
  const feed = $('killFeed');
  feed.appendChild(div);
  while (feed.children.length > 4) feed.removeChild(feed.firstChild);
  setTimeout(() => div.remove(), 4500);
}

// ---------------- HUD ----------------
let lastCountdownSec = null;

function makeScoreRow(p) {
  const row = document.createElement('div');
  row.className = 'score-row';
  row.innerHTML = `<div class="score-dot"></div><div class="score-name${p.id === myId ? ' me' : ''}"></div><div class="score-gems"></div><div class="score-kills"></div>`;
  row.querySelector('.score-dot').style.background = p.color;
  row.querySelector('.score-name').textContent = `${ABILITY_DEFS[p.ab] ? ABILITY_DEFS[p.ab].icon : ''} ${p.name}`;
  row.querySelector('.score-gems').textContent = `💎${p.gems}`;
  row.querySelector('.score-kills').textContent = `⚔${p.kills}`;
  return row;
}

function updateHud(msg) {
  const players = msg.players.filter(p => p.playing);
  const m = players.find(p => p.id === myId);
  const teamMode = roomMode !== 'ffa';
  const nTeams = roomMode === 'teams2' ? 2 : roomMode === 'teams4' ? 4 : 0;

  // team gem totals
  const totals = new Array(Math.max(nTeams, 1)).fill(0);
  if (teamMode) {
    for (const p of players) if (p.tm >= 0) totals[p.tm] += p.gems;
  }

  // gem counter: your team's total in team modes, your own in ffa
  if (m) {
    const shown = teamMode && m.tm >= 0 ? totals[m.tm] : m.gems;
    $('myGems').textContent = shown;
    $('gemHud').classList.toggle('leader', shown >= winGems);
    const you = $('gemYou');
    if (teamMode) { you.textContent = `you: ${m.gems}`; you.classList.remove('hidden'); }
    else you.classList.add('hidden');
  }

  // scoreboard
  const sb = $('scoreboard');
  sb.innerHTML = '';
  if (teamMode) {
    const order = [...Array(nTeams).keys()].sort((a, b) => totals[b] - totals[a]);
    for (const ti of order) {
      const members = players.filter(p => p.tm === ti);
      if (!members.length) continue;
      const head = document.createElement('div');
      head.className = 'score-team';
      head.innerHTML = `<div class="score-dot"></div><div class="score-name"></div><div class="score-gems"></div>`;
      head.querySelector('.score-dot').style.background = TEAM_COLORS[ti];
      head.querySelector('.score-name').textContent = `${TEAM_NAMES[ti]} TEAM`;
      head.querySelector('.score-name').style.color = TEAM_COLORS[ti];
      head.querySelector('.score-gems').textContent = `💎${totals[ti]}`;
      sb.appendChild(head);
      for (const p of members.sort((a, b) => b.gems - a.gems)) sb.appendChild(makeScoreRow(p));
    }
  } else {
    const sorted = [...players].sort((a, b) => b.gems - a.gems || b.kills - a.kills);
    for (const p of sorted) sb.appendChild(makeScoreRow(p));
  }

  // countdown banner
  const cd = $('countdownBanner');
  if (msg.status.countdown != null && msg.status.phase === 'playing') {
    const sec = Math.ceil(msg.status.countdown / 1000);
    let who = '...';
    if (teamMode && msg.status.leaderTeam != null) {
      who = (m && m.tm === msg.status.leaderTeam) ? 'YOUR TEAM WINS' : `${TEAM_NAMES[msg.status.leaderTeam]} TEAM WINS`;
    } else {
      const leader = players.find(p => p.id === msg.status.leaderId);
      if (leader) who = leader.id === myId ? 'YOU WIN' : `${leader.name} WINS`;
    }
    cd.textContent = `${who} IN ${sec}...`;
    cd.classList.remove('hidden');
    if (sec !== lastCountdownSec) { sndTick(); lastCountdownSec = sec; }
  } else {
    cd.classList.add('hidden');
    lastCountdownSec = null;
  }

  // respawn banner
  const rb = $('respawnBanner');
  if (m && m.dead) {
    rb.textContent = `RESPAWNING IN ${Math.ceil(m.respawnIn / 1000)}...`;
    rb.classList.remove('hidden');
  } else rb.classList.add('hidden');

  // win overlay
  const wo = $('winOverlay');
  if (msg.status.phase === 'ended') {
    $('winText').textContent = `${msg.status.winner} WINS!`;
    $('winSub').textContent = `Back to the party in ${Math.ceil((msg.status.resetIn || 0) / 1000)}s`;
    wo.classList.remove('hidden');
  } else wo.classList.add('hidden');
}

// ability cooldown pill (updated every frame for smoothness)
function updateAbilityHud() {
  const el = $('abilityHud');
  const def = ABILITY_DEFS[myAbility];
  const left = abilityCdEnd - performance.now();
  if (left <= 0) {
    el.textContent = `${def.icon} ${def.name.toUpperCase()} READY — right click / F`;
    el.classList.add('ready');
  } else {
    el.textContent = `${def.icon} ${def.name.toUpperCase()} ${(left / 1000).toFixed(1)}s`;
    el.classList.remove('ready');
  }
}

// ---------------- input ----------------
const KEYMAP = {
  KeyW: 'up', ArrowUp: 'up',
  KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
};

function tryAbility() {
  const nowMs = performance.now();
  if (nowMs < abilityCdEnd) return;
  const m = meLatest();
  if (!m || m.dead || !inMatch || (latest && latest.status.phase !== 'playing')) return;
  // movement abilities can't break a stun (matches server rules)
  if ((myAbility === 'dash' || myAbility === 'ghost') && nowMs < pred.stunUntil) return;

  actPending = true;
  abilityCdEnd = nowMs + ABILITY_DEFS[myAbility].cd;

  // predict the dash locally so it feels instant
  if (myAbility === 'dash') {
    const dx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    const dy = (input.down ? 1 : 0) - (input.up ? 1 : 0);
    const a = (dx || dy) ? Math.atan2(dy, dx) : input.aim;
    pred.kvx = Math.cos(a) * 950;
    pred.kvy = Math.sin(a) * 950;
  }
  sendInput();
}

window.addEventListener('keydown', (e) => {
  if (!inMatch) return;
  if (KEYMAP[e.code] !== undefined) {
    if (!input[KEYMAP[e.code]]) { input[KEYMAP[e.code]] = true; sendInput(); }
    e.preventDefault();
  } else if (e.code === 'KeyF') {
    if (!e.repeat) tryAbility();
    e.preventDefault();
  }
});
window.addEventListener('keyup', (e) => {
  if (KEYMAP[e.code] !== undefined) { input[KEYMAP[e.code]] = false; sendInput(); }
});
window.addEventListener('blur', () => {
  input.up = input.down = input.left = input.right = input.fire = false;
});
canvas.addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
canvas.addEventListener('mousedown', (e) => {
  if (!inMatch) return;
  if (e.button === 0) { input.fire = true; sendInput(); }
  else if (e.button === 2) tryAbility();
});
window.addEventListener('mouseup', (e) => { if (e.button === 0) { input.fire = false; sendInput(); } });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------------- prediction (my player, every frame) ----------------
function predictSelf(dt) {
  const m = meLatest();
  if (!m || !pred.init || m.dead) return;

  const nowMs = performance.now();
  const playing = latest.status.phase === 'playing';

  // input movement - blocked while stunned (same rules as server)
  let ivx = 0, ivy = 0;
  if (playing && nowMs >= pred.stunUntil) {
    const dx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    const dy = (input.down ? 1 : 0) - (input.up ? 1 : 0);
    if (dx || dy) {
      const len = Math.hypot(dx, dy);
      let speed = PLAYER_SPEED * (1 - Math.min(m.gems, 10) * 0.02);
      if (nowMs < pred.ghostUntil) speed *= GHOST_SPEED_MULT;
      ivx = (dx / len) * speed;
      ivy = (dy / len) * speed;
    }
  }

  // knockback/dash velocity with the same decay as the server
  const decay = Math.exp(-KB_DECAY * dt);
  pred.kvx *= decay; pred.kvy *= decay;

  const nx = clamp(pred.x + (ivx + pred.kvx) * dt, PLAYER_R, world.w - PLAYER_R);
  if (!circleHitsWall(nx, pred.y, PLAYER_R)) pred.x = nx; else pred.kvx = 0;
  const ny = clamp(pred.y + (ivy + pred.kvy) * dt, PLAYER_R, world.h - PLAYER_R);
  if (!circleHitsWall(pred.x, ny, PLAYER_R)) pred.y = ny; else pred.kvy = 0;

  // gently pull toward the authoritative server position
  if (serverPos) {
    const ex = serverPos.x - pred.x, ey = serverPos.y - pred.y;
    if (Math.hypot(ex, ey) > 150) { pred.x = serverPos.x; pred.y = serverPos.y; }
    else { const k = Math.min(1, dt * 5); pred.x += ex * k; pred.y += ey * k; }
  }
}

// ---------------- interpolation (other players + bullets + bombs) ----------------
function sampleWorld() {
  if (!latest) return null;
  const rt = performance.now() - INTERP_DELAY;

  let a = null, b = null;
  for (let i = snaps.length - 1; i >= 0; i--) {
    if (snaps[i].t <= rt) { a = snaps[i]; b = snaps[i + 1] || null; break; }
  }
  if (!a) { a = snaps[0]; b = snaps[1] || null; }
  if (!a) return null;
  if (!b) return { players: a.msg.players, bullets: a.msg.bullets, bombs: a.msg.bombs || [] };

  const f = clamp((rt - a.t) / Math.max(1, b.t - a.t), 0, 1);
  const pa = new Map(a.msg.players.map(p => [p.id, p]));
  const ba = new Map(a.msg.bullets.map(x => [x.id, x]));
  const ma = new Map((a.msg.bombs || []).map(x => [x.id, x]));

  return {
    players: b.msg.players.map(p => {
      const q = pa.get(p.id);
      return q && !p.dead && !q.dead ? { ...p, x: lerp(q.x, p.x, f), y: lerp(q.y, p.y, f) } : p;
    }),
    bullets: b.msg.bullets.map(x => {
      const q = ba.get(x.id);
      return q ? { ...x, x: lerp(q.x, x.x, f), y: lerp(q.y, x.y, f) } : x;
    }),
    bombs: (b.msg.bombs || []).map(x => {
      const q = ma.get(x.id);
      return q ? { ...x, x: lerp(q.x, x.x, f), y: lerp(q.y, x.y, f) } : x;
    }),
  };
}

// ---------------- rendering ----------------
function resize() {
  canvas.width = window.innerWidth * devicePixelRatio;
  canvas.height = window.innerHeight * devicePixelRatio;
}
window.addEventListener('resize', resize);
resize();

// hand-speckled dirt floor texture, generated once
let floorPattern = null;
function makeFloorPattern() {
  const c = document.createElement('canvas');
  c.width = c.height = 240;
  const g = c.getContext('2d');
  g.fillStyle = '#211910';
  g.fillRect(0, 0, 240, 240);
  const tones = ['#2a2015', '#1b140d', '#332818', '#241c11'];
  for (let i = 0; i < 110; i++) {
    g.fillStyle = tones[Math.floor(Math.random() * tones.length)];
    g.beginPath();
    g.arc(Math.random() * 240, Math.random() * 240, 0.8 + Math.random() * 2.2, 0, Math.PI * 2);
    g.fill();
  }
  // a few little pebbles
  for (let i = 0; i < 7; i++) {
    g.fillStyle = '#3a2d1f';
    g.beginPath();
    g.ellipse(Math.random() * 240, Math.random() * 240, 2 + Math.random() * 3, 1.5 + Math.random() * 2, Math.random() * 3, 0, Math.PI * 2);
    g.fill();
  }
  floorPattern = ctx.createPattern(c, 'repeat');
}

const cam = { x: 1200, y: 900 };
let lastFrame = performance.now();

function draw() {
  requestAnimationFrame(draw);
  const nowMs = performance.now();
  const dt = Math.min(0.05, (nowMs - lastFrame) / 1000);
  lastFrame = nowMs;

  if (!inMatch || !latest) return;
  if (!floorPattern) makeFloorPattern();

  predictSelf(dt);
  updateAbilityHud();

  const view = sampleWorld();
  if (!view) return;

  const m = meLatest();
  const W = canvas.width, H = canvas.height;
  const scale = devicePixelRatio;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#120d09';   // the void outside the arena
  ctx.fillRect(0, 0, W, H);

  // camera follows my predicted position (dead -> server position)
  const camTarget = (m && !m.dead && pred.init) ? pred : (m || cam);
  cam.x = lerp(cam.x, camTarget.x, Math.min(1, dt * 10));
  cam.y = lerp(cam.y, camTarget.y, Math.min(1, dt * 10));

  // screen shake
  shake = Math.max(0, shake - dt * 45);
  const sx = (Math.random() - 0.5) * shake * scale;
  const sy = (Math.random() - 0.5) * shake * scale;

  ctx.setTransform(scale, 0, 0, scale, W / 2 - cam.x * scale + sx, H / 2 - cam.y * scale + sy);

  const viewW = W / scale, viewH = H / scale;
  const vx0 = cam.x - viewW / 2 - 80, vx1 = cam.x + viewW / 2 + 80;
  const vy0 = cam.y - viewH / 2 - 80, vy1 = cam.y + viewH / 2 + 80;

  // ---- dirt floor ----
  ctx.fillStyle = floorPattern;
  ctx.fillRect(0, 0, world.w, world.h);

  // ---- gem mine zone (center) ----
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 185, 56, 0.22)';
  ctx.setLineDash([16, 12]);
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(world.w / 2, world.h / 2, 330, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
  ctx.font = '16px Bungee, Rubik, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255, 185, 56, 0.3)';
  ctx.fillText('⛏ THE MINE', world.w / 2, world.h / 2 - 348);

  // ---- rocky arena border ----
  ctx.strokeStyle = '#0d0906';
  ctx.lineWidth = 22;
  ctx.strokeRect(-6, -6, world.w + 12, world.h + 12);
  ctx.strokeStyle = '#4a3b2b';
  ctx.lineWidth = 14;
  ctx.strokeRect(-4, -4, world.w + 8, world.h + 8);

  // ---- rock walls ----
  for (const w of walls) {
    if (w.x > vx1 || w.x + w.w < vx0 || w.y > vy1 || w.y + w.h < vy0) continue;
    ctx.fillStyle = '#0d0906';
    ctx.beginPath();
    ctx.roundRect(w.x - 4, w.y - 4, w.w + 8, w.h + 8, 9);
    ctx.fill();
    ctx.fillStyle = '#4a3b2b';
    ctx.beginPath();
    ctx.roundRect(w.x, w.y, w.w, w.h, 6);
    ctx.fill();
    // top-light edge so the rocks read as solid
    ctx.fillStyle = '#5f4d37';
    ctx.beginPath();
    ctx.roundRect(w.x + 4, w.y + 4, w.w - 8, 7, 3);
    ctx.fill();
  }

  // ---- gems ----
  const bobT = Math.sin(nowMs / 300) * 3;
  for (const g of latest.gems) {
    if (g.x < vx0 || g.x > vx1 || g.y < vy0 || g.y > vy1) continue;
    drawGem(g.x, g.y + bobT, 13, nowMs / 900 + g.id);
  }

  // ---- bombs ----
  for (const b of view.bombs) {
    // fuse spark
    particles.push({ x: b.x + 4, y: b.y - 12, vx: (Math.random() - 0.5) * 40, vy: -50, life: 0.6, decay: 4, size: 2, color: '#ffb938' });
    ctx.fillStyle = '#0d0906';
    ctx.beginPath();
    ctx.arc(b.x, b.y + 2, 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#2e2419';
    ctx.beginPath();
    ctx.arc(b.x, b.y, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffb938';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(b.x + 3, b.y - 9);
    ctx.quadraticCurveTo(b.x + 8, b.y - 16, b.x + 4, b.y - 13);
    ctx.stroke();
    // danger blink as the fuse runs out
    if (b.fuse < 300 && Math.floor(nowMs / 80) % 2 === 0) {
      ctx.fillStyle = 'rgba(232, 86, 63, 0.55)';
      ctx.beginPath();
      ctx.arc(b.x, b.y, 11, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---- bullets with trails ----
  const liveBullets = new Set();
  for (const b of view.bullets) {
    liveBullets.add(b.id);
    const prev = bulletTrails.get(b.id);
    if (prev) {
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = b.color;
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    bulletTrails.set(b.id, { x: b.x, y: b.y });

    ctx.fillStyle = b.color;
    ctx.strokeStyle = '#0d0906';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(b.x, b.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  for (const id of bulletTrails.keys()) if (!liveBullets.has(id)) bulletTrails.delete(id);

  // ---- players ----
  // crown goes to whoever holds the most gems (min 1)
  let crownId = null, crownGems = 0;
  for (const p of view.players) {
    if (p.playing && !p.dead && p.gems > crownGems) { crownGems = p.gems; crownId = p.id; }
  }

  for (const p of view.players) {
    if (!p.playing || p.dead) continue;
    if (p.id === myId && pred.init) {
      drawPlayer({ ...p, x: pred.x, y: pred.y, st: Math.max(0, pred.stunUntil - nowMs), gh: Math.max(0, pred.ghostUntil - nowMs) }, true, nowMs, crownId === p.id);
    } else {
      drawPlayer(p, false, nowMs, crownId === p.id);
    }
  }

  // ---- particles ----
  for (let i = particles.length - 1; i >= 0; i--) {
    const pt = particles[i];
    pt.x += pt.vx * dt; pt.y += pt.vy * dt;
    pt.vx *= 0.94; pt.vy *= 0.94;
    pt.life -= pt.decay * dt;
    if (pt.life <= 0) { particles.splice(i, 1); continue; }
    ctx.globalAlpha = Math.max(0, pt.life);
    if (pt.ring) {
      ctx.strokeStyle = pt.color;
      ctx.lineWidth = 6 * pt.life;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, pt.size * (1.4 - pt.life), 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.fillStyle = pt.color;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, pt.size * pt.life, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  // ---- floating damage numbers ----
  ctx.textAlign = 'center';
  for (let i = dmgTexts.length - 1; i >= 0; i--) {
    const d = dmgTexts[i];
    d.y -= 55 * dt;
    d.life -= 1.1 * dt;
    if (d.life <= 0) { dmgTexts.splice(i, 1); continue; }
    ctx.globalAlpha = Math.min(1, d.life * 2);
    ctx.font = `800 ${d.text.startsWith('-') ? 21 : 16}px Rubik, "Segoe UI", sans-serif`;
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(13, 9, 6, 0.7)';
    ctx.strokeText(d.text, d.x, d.y);
    ctx.fillStyle = d.color;
    ctx.fillText(d.text, d.x, d.y);
  }
  ctx.globalAlpha = 1;

  // ---- screen-space overlays ----
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  drawVignette(m, nowMs, dt, W, H);
  drawMinimap(view, W, H, scale);

  // update aim angle from mouse (screen -> world)
  if (m && pred.init) {
    const wx = cam.x + (mouse.x - window.innerWidth / 2);
    const wy = cam.y + (mouse.y - window.innerHeight / 2);
    input.aim = Math.atan2(wy - pred.y, wx - pred.x);
  }
}

// red damage vignette: flashes when you're hit, pulses when low HP
function drawVignette(m, nowMs, dt, W, H) {
  redFlash = Math.max(0, redFlash - dt * 2.2);
  let alpha = redFlash * 0.55;
  if (m && !m.dead && m.hp <= 40) {
    alpha = Math.max(alpha, 0.14 + 0.09 * Math.sin(nowMs / 160));
  }
  if (alpha <= 0.01) return;
  const grad = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.72);
  grad.addColorStop(0, 'rgba(232, 60, 40, 0)');
  grad.addColorStop(1, `rgba(232, 60, 40, ${alpha})`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
}

function drawMinimap(view, W, H, scale) {
  const mw = 176 * scale, mh = mw * (world.h / world.w);
  const mx = 14 * scale, my = H - mh - 14 * scale;
  const k = mw / world.w;

  ctx.fillStyle = 'rgba(26, 19, 12, 0.88)';
  ctx.strokeStyle = '#59452c';
  ctx.lineWidth = 2 * scale;
  ctx.beginPath();
  ctx.roundRect(mx, my, mw, mh, 6 * scale);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = 'rgba(120, 98, 68, 0.6)';
  for (const w of walls) ctx.fillRect(mx + w.x * k, my + w.y * k, Math.max(2, w.w * k), Math.max(2, w.h * k));

  ctx.strokeStyle = 'rgba(255, 185, 56, 0.35)';
  ctx.lineWidth = scale;
  ctx.beginPath();
  ctx.arc(mx + mw / 2, my + mh / 2, 330 * k, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = '#ffb938';
  for (const g of latest.gems) {
    ctx.beginPath();
    ctx.arc(mx + g.x * k, my + g.y * k, 1.6 * scale, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const p of view.players) {
    if (!p.playing || p.dead) continue;
    if (p.gh > 0 && p.id !== myId) continue; // ghosts don't show on the minimap
    const px = p.id === myId && pred.init ? pred.x : p.x;
    const py = p.id === myId && pred.init ? pred.y : p.y;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(mx + px * k, my + py * k, (p.id === myId ? 3.4 : 2.6) * scale, 0, Math.PI * 2);
    ctx.fill();
    if (p.id === myId) {
      ctx.strokeStyle = '#f4e9d4';
      ctx.lineWidth = scale;
      ctx.stroke();
    }
  }
}

function drawGem(x, y, r, rot) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.sin(rot) * 0.35);
  const grad = ctx.createLinearGradient(-r, -r, r, r);
  grad.addColorStop(0, '#ffe9a8');
  grad.addColorStop(0.5, '#ffb938');
  grad.addColorStop(1, '#e07f1e');
  ctx.fillStyle = grad;
  ctx.strokeStyle = '#0d0906';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.lineTo(r * 0.85, 0);
  ctx.lineTo(0, r);
  ctx.lineTo(-r * 0.85, 0);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // little sparkle
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-r * 0.3, -r * 0.35);
  ctx.lineTo(-r * 0.1, -r * 0.15);
  ctx.stroke();
  ctx.restore();
}

function drawPlayer(p, isMe, nowMs, hasCrown) {
  const r = PLAYER_R;
  const ghosted = p.gh > 0;

  // ghosts are barely visible to enemies, half-visible to themselves
  if (ghosted) ctx.globalAlpha = isMe ? 0.5 : 0.13;

  // ground shadow
  ctx.fillStyle = 'rgba(13, 9, 6, 0.4)';
  ctx.beginPath();
  ctx.ellipse(p.x, p.y + r * 0.85, r * 0.8, r * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();

  // spawn-protection shield
  if (p.inv) {
    ctx.strokeStyle = `rgba(143, 206, 78, ${0.5 + 0.25 * Math.sin(nowMs / 120)})`;
    ctx.lineWidth = 3;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + 8, nowMs / 400, nowMs / 400 + Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // ability shield bubble
  if (p.sh > 0) {
    ctx.fillStyle = 'rgba(111, 212, 255, 0.16)';
    ctx.strokeStyle = `rgba(111, 212, 255, ${0.6 + 0.3 * Math.sin(nowMs / 90)})`;
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // body with chunky dark outline
  ctx.fillStyle = p.color;
  ctx.strokeStyle = '#0d0906';
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // white hit-flash overlay
  const flashAt = hitFlashes.get(p.id);
  if (flashAt !== undefined) {
    const age = nowMs - flashAt;
    if (age < 150) {
      ctx.globalAlpha = (ghosted ? (isMe ? 0.5 : 0.13) : 1) * (1 - age / 150) * 0.85;
      ctx.fillStyle = '#fff3d6';
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = ghosted ? (isMe ? 0.5 : 0.13) : 1;
    } else hitFlashes.delete(p.id);
  }

  // ring marker on my player
  if (isMe) {
    ctx.strokeStyle = '#f4e9d4';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r - 4, 0, Math.PI * 2);
    ctx.stroke();
  }

  // gun barrel (mine only - server doesn't broadcast other players' aim)
  if (isMe) {
    const aim = input.aim;
    ctx.strokeStyle = '#0d0906';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(p.x + Math.cos(aim) * (r - 4), p.y + Math.sin(aim) * (r - 4));
    ctx.lineTo(p.x + Math.cos(aim) * (r + 12), p.y + Math.sin(aim) * (r + 12));
    ctx.stroke();
    ctx.strokeStyle = '#f4e9d4';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(p.x + Math.cos(aim) * (r - 4), p.y + Math.sin(aim) * (r - 4));
    ctx.lineTo(p.x + Math.cos(aim) * (r + 11), p.y + Math.sin(aim) * (r + 11));
    ctx.stroke();
  }

  // stunned: orbiting dizzy sparks
  if (p.st > 0) {
    ctx.fillStyle = '#ffb938';
    for (let i = 0; i < 3; i++) {
      const a = nowMs / 90 + (i * Math.PI * 2) / 3;
      ctx.beginPath();
      ctx.arc(p.x + Math.cos(a) * (r + 9), p.y - 6 + Math.sin(a) * 8, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // eyes (X-eyes while stunned)
  ctx.fillStyle = '#0d0906';
  if (p.st > 0) {
    ctx.font = '900 11px Rubik, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('✕', p.x - 7, p.y);
    ctx.fillText('✕', p.x + 7, p.y);
  } else {
    ctx.beginPath();
    ctx.arc(p.x - 7, p.y - 4, 3.5, 0, Math.PI * 2);
    ctx.arc(p.x + 7, p.y - 4, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // crown for the gem leader
  if (hasCrown) {
    ctx.font = '18px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('👑', p.x, p.y - r - 34);
  }

  // name
  ctx.font = '600 13px Rubik, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(13, 9, 6, 0.75)';
  ctx.strokeText(p.name, p.x, p.y - r - 22);
  ctx.fillStyle = isMe ? '#ffb938' : '#f4e9d4';
  ctx.fillText(p.name, p.x, p.y - r - 22);

  // hp bar
  const bw = 52, bh = 6;
  ctx.fillStyle = 'rgba(13, 9, 6, 0.7)';
  ctx.fillRect(p.x - bw / 2 - 1, p.y - r - 17, bw + 2, bh + 2);
  const hpFrac = Math.max(0, p.hp / 100);
  ctx.fillStyle = hpFrac > 0.5 ? '#8fce4e' : hpFrac > 0.25 ? '#ffb938' : '#e8563f';
  ctx.fillRect(p.x - bw / 2, p.y - r - 16, bw * hpFrac, bh);

  // carried gems badge
  if (p.gems > 0) {
    drawGem(p.x, p.y + r + 14, 7, nowMs / 700);
    ctx.font = '800 13px Rubik, sans-serif';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(13, 9, 6, 0.75)';
    ctx.strokeText(String(p.gems), p.x + 14, p.y + r + 18);
    ctx.fillStyle = '#ffb938';
    ctx.fillText(String(p.gems), p.x + 14, p.y + r + 18);
  }

  ctx.globalAlpha = 1;
}

requestAnimationFrame(draw);
