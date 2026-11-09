// Serveur de poker Texas Hold'em (jetons fictifs) — Node.js + WebSocket
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const START_CHIPS = 1000, SB = 10, BB = 20, MAX_SEATS = 9;
const FAST = !!process.env.POKER_FAST; // pour les tests automatiques
const TURN_MS = FAST ? 400 : 30000, DISCONNECTED_TURN_MS = 6000, NEXT_HAND_MS = FAST ? 30 : 8000, STREET_MS = FAST ? 10 : 1400;

// ---------- cartes & évaluation ----------
// carte = 0..51 ; rang = (c>>2)+2 (2..14) ; couleur = c&3
const rankOf = c => (c >> 2) + 2;
const suitOf = c => c & 3;

function shuffledDeck() {
  const d = Array.from({ length: 52 }, (_, i) => i);
  for (let i = d.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}
function eval5(cs) {
  const rs = cs.map(rankOf).sort((a, b) => b - a);
  const flush = cs.every(c => suitOf(c) === suitOf(cs[0]));
  const cnt = {};
  for (const r of rs) cnt[r] = (cnt[r] || 0) + 1;
  const g = Object.entries(cnt).map(([r, n]) => [+r, n]).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const u = [...new Set(rs)];
  let sh = 0;
  if (u.length === 5) {
    if (u[0] - u[4] === 4) sh = u[0];
    else if (u[0] === 14 && u[1] === 5) sh = 5;
  }
  if (sh && flush) return [8, sh];
  if (g[0][1] === 4) return [7, g[0][0], g[1][0]];
  if (g[0][1] === 3 && g[1][1] === 2) return [6, g[0][0], g[1][0]];
  if (flush) return [5, ...rs];
  if (sh) return [4, sh];
  if (g[0][1] === 3) return [3, g[0][0], g[1][0], g[2][0]];
  if (g[0][1] === 2 && g[1][1] === 2) return [2, g[0][0], g[1][0], g[2][0]];
  if (g[0][1] === 2) return [1, g[0][0], g[1][0], g[2][0], g[3][0]];
  return [0, ...rs];
}
function cmp(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}
function best7(cards) {
  let best = null;
  const n = cards.length;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
    const five = cards.filter((_, i) => i !== a && i !== b);
    if (five.length !== 5) continue;
    const s = eval5(five);
    if (!best || cmp(s, best) > 0) best = s;
  }
  return best;
}
function rname(r, pl) {
  if (r === 14) return 'As';
  if (r === 13) return pl ? 'Rois' : 'Roi';
  if (r === 12) return pl ? 'Dames' : 'Dame';
  if (r === 11) return pl ? 'Valets' : 'Valet';
  return String(r);
}
function handName(s) {
  switch (s[0]) {
    case 8: return s[1] === 14 ? 'Quinte flush royale' : 'Quinte flush (' + rname(s[1]) + ' haut)';
    case 7: return 'Carré de ' + rname(s[1], true);
    case 6: return 'Full (' + rname(s[1], true) + ' par les ' + rname(s[2], true) + ')';
    case 5: return 'Couleur (' + rname(s[1]) + ' haut)';
    case 4: return 'Quinte (' + rname(s[1]) + ' haut)';
    case 3: return 'Brelan de ' + rname(s[1], true);
    case 2: return 'Double paire (' + rname(s[1], true) + ' et ' + rname(s[2], true) + ')';
    case 1: return 'Paire de ' + rname(s[1], true);
    default: return 'Carte haute (' + rname(s[1]) + ')';
  }
}

// ---------- salle ----------
const rooms = new Map();
let nextId = 1;
const send = (ws, obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };

function genCode() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (let t = 0; t < 100; t++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += L[crypto.randomInt(L.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}

class Room {
  constructor(code) {
    this.code = code;
    this.players = [];
    this.dealer = -1;
    this.phase = 'waiting'; // waiting | preflop | flop | turn | river | ended
    this.board = [];
    this.deck = [];
    this.cur = 0;
    this.minRaise = BB;
    this.toAct = -1;
    this.sbI = -1; this.bbI = -1;
    this.deadline = 0;
    this.result = null;
    this.log = [];
    this.hostId = null;
    this.timer = null; this.nextTimer = null; this.stepTimer = null;
    this.lastSeen = Date.now();
  }
  say(msg) { this.log.push(msg); if (this.log.length > 40) this.log.shift(); }
  get betting() { return ['preflop', 'flop', 'turn', 'river'].includes(this.phase); }

  addPlayer(ws, name, token) {
    let p = token ? this.players.find(x => x.token === token) : null;
    if (p) {
      p.ws = ws; p.connected = true; p.left = false;
      return p;
    }
    if (this.players.filter(x => !x.left).length >= MAX_SEATS) return null;
    name = (name || 'Joueur').trim().slice(0, 16) || 'Joueur';
    let base = name, k = 2;
    while (this.players.some(x => !x.left && x.name === name)) name = base + ' ' + k++;
    p = {
      id: nextId++, token: crypto.randomBytes(12).toString('hex'), name, ws, connected: true, left: false,
      chips: START_CHIPS, inHand: false, folded: true, allIn: false, bet: 0, total: 0, hasActed: false,
      cards: [], revealed: false, won: 0, lastAct: '', score: null
    };
    this.players.push(p);
    if (!this.hostId) this.hostId = p.id;
    this.say(p.name + ' rejoint la table');
    return p;
  }

  // --- vue envoyée à un joueur ---
  view(me) {
    const pot = this.players.reduce((s, p) => s + p.total, 0);
    const myTurn = this.betting && this.toAct >= 0 && this.players[this.toAct] === me;
    const toCall = Math.max(0, this.cur - me.bet);
    return {
      t: 'state', code: this.code, you: me.id, hostId: this.hostId, phase: this.phase,
      board: this.board, pot, cur: this.cur, blinds: [SB, BB],
      toAct: this.toAct >= 0 && this.players[this.toAct] ? this.players[this.toAct].id : null,
      ttl: this.toAct >= 0 ? Math.max(0, this.deadline - Date.now()) : 0,
      toCall, minRaiseTo: Math.min(this.cur + this.minRaise, me.bet + me.chips), maxRaiseTo: me.bet + me.chips,
      myTurn,
      players: this.players.filter(p => !p.left).map(p => {
        const idx = this.players.indexOf(p);
        let cards = [];
        if (p === me) cards = p.cards;
        else if (p.revealed) cards = p.cards;
        else if (p.inHand && !p.folded) cards = [-1, -1];
        return {
          id: p.id, name: p.name, chips: p.chips, bet: p.bet, folded: p.folded, allIn: p.allIn,
          connected: p.connected, inHand: p.inHand, dealer: idx === this.dealer && this.phase !== 'waiting',
          sb: idx === this.sbI && this.betting, bb: idx === this.bbI && this.betting,
          cards, hand: p.revealed && p.score ? handName(p.score) : '', won: p.won, lastAct: p.lastAct
        };
      }),
      result: this.result, log: this.log.slice(-14)
    };
  }
  broadcast() {
    this.lastSeen = Date.now();
    for (const p of this.players) if (p.connected && !p.left) send(p.ws, this.view(p));
  }

  // --- utilitaires ---
  nextIdx(from, pred) {
    const n = this.players.length;
    for (let k = 1; k <= n; k++) {
      const i = ((from + k) % n + n) % n;
      if (pred(this.players[i])) return i;
    }
    return -1;
  }
  findActor(start) {
    const n = this.players.length;
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n, p = this.players[i];
      if (p.inHand && !p.folded && !p.allIn && p.chips > 0) return i;
    }
    return -1;
  }
  pay(p, amt) {
    amt = Math.max(0, Math.min(amt, p.chips));
    p.chips -= amt; p.bet += amt; p.total += amt;
    if (p.chips === 0) p.allIn = true;
    return amt;
  }
  cleanup() {
    const keep = [];
    let d = this.dealer;
    this.players.forEach((p, i) => {
      if (p.left) { if (i <= this.dealer) d--; } else keep.push(p);
    });
    this.players = keep;
    this.dealer = d;
    this.sbI = -1; this.bbI = -1;
    if (!this.players.some(p => p.id === this.hostId)) {
      const h = this.players.find(p => p.connected) || this.players[0];
      this.hostId = h ? h.id : null;
    }
  }

  // --- déroulement ---
  startHand() {
    clearTimeout(this.nextTimer); clearTimeout(this.stepTimer); clearTimeout(this.timer);
    if (this.betting) return;
    this.cleanup();
    const el = this.players.filter(p => p.chips > 0 && !p.left);
    if (el.length < 2) { this.phase = 'waiting'; this.result = null; this.broadcast(); return; }
    this.result = null; this.board = []; this.deck = shuffledDeck(); this.cur = 0; this.minRaise = BB;
    for (const p of this.players) {
      p.inHand = el.includes(p); p.cards = []; p.bet = 0; p.total = 0; p.folded = !p.inHand;
      p.allIn = false; p.hasActed = false; p.revealed = false; p.won = 0; p.lastAct = ''; p.score = null;
    }
    this.dealer = this.nextIdx(this.dealer, p => p.inHand);
    for (let r = 0; r < 2; r++) for (const p of this.players) if (p.inHand) p.cards.push(this.deck.pop());
    let sbI, bbI;
    if (el.length === 2) { sbI = this.dealer; bbI = this.nextIdx(sbI, p => p.inHand); }
    else { sbI = this.nextIdx(this.dealer, p => p.inHand); bbI = this.nextIdx(sbI, p => p.inHand); }
    this.sbI = sbI; this.bbI = bbI;
    const a = this.pay(this.players[sbI], SB), b = this.pay(this.players[bbI], BB);
    this.cur = BB; this.minRaise = BB;
    this.say('— Nouvelle main —');
    this.say(this.players[sbI].name + ' paie la petite blind (' + a + '), ' + this.players[bbI].name + ' la grosse blind (' + b + ')');
    this.phase = 'preflop';
    const first = el.length === 2 ? sbI : (bbI + 1) % this.players.length;
    this.advance(first);
  }

  armTimer() {
    clearTimeout(this.timer);
    const p = this.players[this.toAct];
    if (!p) return;
    const ms = p.connected ? TURN_MS : DISCONNECTED_TURN_MS;
    this.deadline = Date.now() + ms;
    this.timer = setTimeout(() => {
      const q = this.players[this.toAct];
      if (!q || !this.betting) return;
      this.say(q.name + ' : temps écoulé');
      this.act(q, q.bet >= this.cur ? 'check' : 'fold');
    }, ms);
  }

  act(p, a, amount) {
    const i = this.players.indexOf(p);
    if (!this.betting || i !== this.toAct) return 'Ce n\'est pas ton tour';
    const toCall = Math.max(0, this.cur - p.bet);
    const maxT = p.bet + p.chips;
    if (a === 'check' && toCall > 0) return 'Tu ne peux pas checker';
    let target = 0;
    if (a === 'raise' || a === 'allin') {
      target = a === 'allin' ? maxT : Math.floor(Number(amount));
      if (!(target > 0)) return 'Montant invalide';
      if (target > maxT) target = maxT;
      if (target > this.cur && target < this.cur + this.minRaise && target < maxT) {
        return 'Relance trop faible (minimum ' + (this.cur + this.minRaise) + ')';
      }
    } else if (!['fold', 'check', 'call'].includes(a)) return 'Action inconnue';

    clearTimeout(this.timer);
    if (a === 'fold') {
      p.folded = true; p.lastAct = 'Couché'; this.say(p.name + ' se couche');
    } else if (a === 'check') {
      p.lastAct = 'Check'; this.say(p.name + ' checke');
    } else if (a === 'call' || (target <= this.cur)) {
      const paid = this.pay(p, toCall);
      p.lastAct = p.allIn ? 'Tapis' : 'Suit'; this.say(p.name + (p.allIn ? ' est à tapis (' + paid + ')' : ' suit (' + paid + ')'));
    } else {
      const size = target - this.cur, wasOpen = this.cur > 0;
      this.pay(p, target - p.bet);
      if (size >= this.minRaise) this.minRaise = size;
      this.cur = target;
      for (const q of this.players) if (q !== p && q.inHand && !q.folded && !q.allIn) q.hasActed = false;
      p.lastAct = p.allIn ? 'Tapis' : (wasOpen ? 'Relance' : 'Mise');
      this.say(p.name + (p.allIn ? ' est à tapis' : (wasOpen ? ' relance à ' : ' mise ')) + (p.allIn ? ' (' + target + ')' : target));
    }
    p.hasActed = true;
    this.advance((i + 1) % this.players.length);
    return null;
  }

  advance(start) {
    const live = this.players.filter(p => p.inHand && !p.folded);
    if (live.length === 1) return this.finishUncontested(live[0]);
    const can = live.filter(p => !p.allIn && p.chips > 0);
    const done = can.length === 0 || (can.length === 1 && can[0].bet >= this.cur) ||
      can.every(p => p.hasActed && p.bet === this.cur);
    if (!done) {
      this.toAct = this.findActor(start);
      this.armTimer();
      return this.broadcast();
    }
    this.toAct = -1; clearTimeout(this.timer);
    if (this.phase === 'river') return this.showdown();
    for (const p of this.players) { p.bet = 0; p.hasActed = false; p.lastAct = p.folded || p.allIn ? p.lastAct : ''; }
    this.cur = 0; this.minRaise = BB;
    const order = ['preflop', 'flop', 'turn', 'river'];
    this.phase = order[order.indexOf(this.phase) + 1];
    this.deck.pop(); // brûlée
    const n = this.phase === 'flop' ? 3 : 1;
    for (let k = 0; k < n; k++) this.board.push(this.deck.pop());
    const can2 = live.filter(p => !p.allIn && p.chips > 0);
    if (can2.length <= 1) {
      this.broadcast();
      this.stepTimer = setTimeout(() => this.advance(0), STREET_MS);
    } else {
      this.advance((this.dealer + 1) % this.players.length);
    }
  }

  finishUncontested(w) {
    const pot = this.players.reduce((s, p) => s + p.total, 0);
    w.chips += pot; w.won = pot;
    this.result = { showdown: false, pots: [{ amount: pot, winners: [w.id], names: [w.name], hand: '' }] };
    this.say(w.name + ' remporte ' + pot + ' (tout le monde s\'est couché)');
    this.endHand();
  }

  showdown() {
    const live = this.players.filter(p => p.inHand && !p.folded);
    for (const p of live) { p.score = best7(p.cards.concat(this.board)); p.revealed = true; }
    const levels = [...new Set(this.players.filter(p => p.total > 0).map(p => p.total))].sort((a, b) => a - b);
    let prev = 0; const pots = [];
    for (const lvl of levels) {
      const amount = this.players.reduce((s, p) => s + Math.min(p.total, lvl) - Math.min(p.total, prev), 0);
      const elig = live.filter(p => p.total >= lvl);
      if (!elig.length) { if (pots.length) pots[pots.length - 1].amount += amount; prev = lvl; continue; }
      let bestS = elig[0].score;
      for (const p of elig) if (cmp(p.score, bestS) > 0) bestS = p.score;
      const winners = elig.filter(p => cmp(p.score, bestS) === 0);
      const share = Math.floor(amount / winners.length);
      let rem = amount - share * winners.length;
      const ordered = [...winners].sort((a, b) => {
        const n = this.players.length, ia = (this.players.indexOf(a) - this.dealer - 1 + n) % n, ib = (this.players.indexOf(b) - this.dealer - 1 + n) % n;
        return ia - ib;
      });
      for (const w of ordered) { const g = share + (rem > 0 ? 1 : 0); if (rem > 0) rem--; w.chips += g; w.won += g; }
      pots.push({ amount, winners: winners.map(w => w.id), names: winners.map(w => w.name), hand: handName(bestS) });
      prev = lvl;
    }
    this.result = { showdown: true, pots };
    pots.forEach((pt, i) => this.say((i ? 'Pot secondaire' : 'Pot principal') + ' (' + pt.amount + ') : ' + pt.names.join(', ') + ' — ' + pt.hand));
    this.endHand();
  }

  endHand() {
    clearTimeout(this.timer); clearTimeout(this.stepTimer);
    this.toAct = -1; this.phase = 'ended';
    this.broadcast();
    this.nextTimer = setTimeout(() => this.startHand(), NEXT_HAND_MS);
  }

  removePlayer(p) {
    p.left = true;
    if (this.betting && p.inHand && !p.folded) {
      if (this.players[this.toAct] === p) this.act(p, 'fold');
      else { p.folded = true; this.say(p.name + ' quitte la table'); this.advance(this.toAct >= 0 ? this.toAct : 0); }
    } else {
      this.say(p.name + ' quitte la table');
      this.broadcast();
    }
    if (this.hostId === p.id) {
      const h = this.players.find(x => !x.left && x.connected);
      this.hostId = h ? h.id : null;
      this.broadcast();
    }
  }
}

// ---------- serveur HTTP + WebSocket ----------
const poulpe = require('./poulpe');
const PAGES = { '/': 'index.html', '/poker': 'poker.html', '/poulpe': 'poulpe.html' };
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';
  if (url === '/health') { res.writeHead(200); return res.end('ok'); }
  const page = PAGES[url];
  if (!page) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Page introuvable'); }
  fs.readFile(path.join(__dirname, 'public', page), (err, data) => {
    if (err) { res.writeHead(500); return res.end('Erreur'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
server.on('upgrade', (req, socket, head) => {
  const p = (req.url || '').split('?')[0];
  const target = p === '/ws' ? wss : (p === '/ws-poulpe' ? poulpe.wss : null);
  if (!target) { socket.destroy(); return; }
  target.handleUpgrade(req, socket, head, ws => target.emit('connection', ws, req));
});

wss.on('connection', ws => {
  ws.isAlive = true; ws.msgs = 0;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    if (++ws.msgs > 40) return; // anti-spam (réinitialisé chaque seconde)
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    try { handle(ws, m); } catch (e) { console.error(e); }
  });
  ws.on('close', () => {
    const p = ws.player, room = ws.room;
    if (p && room && p.ws === ws) {
      p.connected = false;
      room.say(p.name + ' est déconnecté');
      if (room.hostId === p.id) {
        const h = room.players.find(x => !x.left && x.connected);
        if (h) room.hostId = h.id;
      }
      room.broadcast();
    }
  });
});

function handle(ws, m) {
  if (m.t === 'create' || m.t === 'join') {
    if (ws.player) return;
    let room;
    if (m.t === 'create') {
      if (rooms.size >= 300) return send(ws, { t: 'err', msg: 'Serveur plein, réessaie plus tard' });
      const code = genCode();
      room = new Room(code); rooms.set(code, room);
    } else {
      room = rooms.get(String(m.code || '').toUpperCase().trim());
      if (!room) return send(ws, { t: 'err', msg: 'Table introuvable', fatal: !!m.token });
    }
    const p = room.addPlayer(ws, String(m.name || ''), m.token);
    if (!p) return send(ws, { t: 'err', msg: 'La table est pleine (9 joueurs max)' });
    ws.player = p; ws.room = room;
    send(ws, { t: 'joined', code: room.code, token: p.token, name: p.name });
    room.broadcast();
    return;
  }
  const p = ws.player, room = ws.room;
  if (!p || !room) return;
  if (m.t === 'start') {
    if (room.hostId !== p.id) return send(ws, { t: 'err', msg: 'Seul l\'hôte peut lancer la partie' });
    if (room.phase === 'waiting') room.startHand();
  } else if (m.t === 'act') {
    const e = room.act(p, String(m.a), m.amount);
    if (e) send(ws, { t: 'err', msg: e });
  } else if (m.t === 'rebuy') {
    if (p.chips === 0 && (!room.betting || !p.inHand)) {
      p.chips = START_CHIPS; room.say(p.name + ' recave (' + START_CHIPS + ')');
      room.broadcast();
      if (room.phase === 'waiting' && room.players.filter(x => x.chips > 0 && !x.left).length >= 2) { /* l'hôte relance */ }
    }
  } else if (m.t === 'chat') {
    const text = String(m.text || '').slice(0, 200).trim();
    if (!text) return;
    for (const q of room.players) if (q.connected && !q.left) send(q.ws, { t: 'chat', name: p.name, text });
  } else if (m.t === 'leave') {
    room.removePlayer(p);
    ws.player = null; ws.room = null;
    send(ws, { t: 'left' });
  }
}

setInterval(() => { for (const ws of wss.clients) ws.msgs = 0; }, 1000);
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
  const now = Date.now();
  for (const [code, r] of rooms) {
    if (!r.players.some(p => p.connected && !p.left) && now - r.lastSeen > 10 * 60 * 1000) {
      clearTimeout(r.timer); clearTimeout(r.nextTimer); clearTimeout(r.stepTimer);
      rooms.delete(code);
    }
  }
}, 25000);

if (require.main === module) {
  server.listen(PORT, () => console.log('Poker prêt sur le port ' + PORT));
}
module.exports = { server, rooms, Room, best7, eval5, cmp, handName };
