// Poulpe — jeu de plis à annonces (cartes 1 à 60 + 4 Poulpes jokers) — WebSocket
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const FAST = !!process.env.POKER_FAST; // tests automatiques
const TM = {
  turn: FAST ? 300 : 45000, off: FAST ? 40 : 5000, trick: FAST ? 30 : 1900,
  wheel: FAST ? 60 : 6800, round: FAST ? 120 : 12000, tie: FAST ? 100 : 11000
};
const MAXP = 20, MINP = 2, NUMS = 60, DECK = 64; // 1..60 = nombres ; 61..64 = Poulpes

const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
const rooms = new Map();
let nextId = 1;
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const rnd = n => crypto.randomInt(n);

function shuffled() {
  const d = Array.from({ length: DECK }, (_, i) => i + 1);
  for (let i = d.length - 1; i > 0; i--) { const j = rnd(i + 1); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}
function genCode() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (let t = 0; t < 100; t++) {
    let c = ''; for (let i = 0; i < 4; i++) c += L[rnd(L.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}
// valeur d'une carte jouée : Poulpe haut = 100 (bat tout), Poulpe bas = 0 (perd contre tout nombre)
function trickWinnerIdx(trick) {
  // Poulpes joués en « plus » (grand) : le DERNIER posé gagne toujours
  let lastH = -1;
  trick.forEach((t, i) => { if (t.card > NUMS && t.mode === 'H') lastH = i; });
  if (lastH >= 0) return lastH;
  let best = -1, bi = 0;
  trick.forEach((t, i) => {
    const v = t.card <= NUMS ? t.card : (t.mode === 'H' ? 100 : 0);
    if (v > best) { best = v; bi = i; }   // égalité : le premier posé gagne
  });
  return bi;
}

class Room {
  constructor(code) {
    this.code = code; this.players = []; this.hostId = null;
    this.phase = 'lobby'; // lobby | wheel | choose | bid | play | trickEnd | roundEnd | tiebreak | over
    this.totalRounds = 10; this.round = 0; this.dealer = -1; this.nCards = 0;
    this.turn = -1; this.trick = []; this.trickWinner = null; this.results = null;
    this.tiebreak = null; this.loser = null; this.finalNum = null; this.wheel = null; this.wheelSeq = 0;
    this.dealt = new Set(); // joueurs qui ont déjà distribué dans le tour en cours
    this.deadline = 0; this.log = []; this.timer = null; this.hold = null; this.lastSeen = Date.now();
  }
  say(m) { this.log.push(m); if (this.log.length > 40) this.log.shift(); }
  later(ms, fn) { clearTimeout(this.hold); this.hold = setTimeout(fn, ms); }
  get inGame() { return this.phase !== 'lobby'; }
  get maxChoose() { return Math.floor(DECK / this.players.length); }
  pid(i) { return this.players[i] ? this.players[i].id : null; }

  addPlayer(ws, name, token) {
    let p = token ? this.players.find(x => x.token === token) : null;
    if (p) { p.ws = ws; p.connected = true; p.left = false; return p; }
    if (this.inGame) return { error: 'La partie a déjà commencé' };
    if (this.players.length >= MAXP) return { error: 'La table est pleine (20 joueurs max)' };
    name = (name || 'Joueur').trim().slice(0, 16) || 'Joueur';
    const base = name; let k = 2;
    while (this.players.some(x => x.name === name)) name = base + ' ' + k++;
    p = { id: nextId++, token: crypto.randomBytes(12).toString('hex'), name, ws, connected: true, left: false, hand: [], bid: null, won: 0, bars: 0 };
    this.players.push(p);
    if (!this.hostId) this.hostId = p.id;
    this.say(p.name + ' rejoint la table');
    return p;
  }

  view(me) {
    const lastBidder = this.phase === 'bid' && this.turn >= 0 && this.turn === this.dealer && this.players[this.turn] === me;
    let forbidden = null;
    if (lastBidder) {
      const sum = this.players.reduce((s, p) => s + (p !== me && p.bid !== null ? p.bid : 0), 0);
      const f = this.nCards - sum;
      if (f >= 0 && f <= this.nCards) forbidden = f;
    }
    return {
      t: 'state', code: this.code, you: me.id, hostId: this.hostId, phase: this.phase,
      round: this.round, totalRounds: this.totalRounds, nCards: this.nCards, maxChoose: this.players.length ? this.maxChoose : 0,
      dealerId: this.pid(this.dealer), turnId: this.phase === 'trickEnd' ? null : this.pid(this.turn),
      ttl: ['choose', 'bid', 'play'].includes(this.phase) ? Math.max(0, this.deadline - Date.now()) : 0,
      players: this.players.map(p => ({ id: p.id, name: p.name, connected: p.connected && !p.left, bid: p.bid, won: p.won, bars: p.bars, cards: p.hand.length })),
      hand: [...me.hand].sort((a, b) => a - b),
      trick: this.trick.map(t => ({ pid: t.pid, card: t.card, mode: t.mode })), trickWinner: this.trickWinner,
      forbidden, wheel: this.wheel, results: this.results, tiebreak: this.tiebreak, loser: this.loser, finalNum: this.finalNum,
      log: this.log.slice(-12)
    };
  }
  broadcast() {
    this.lastSeen = Date.now();
    for (const p of this.players) if (p.connected && !p.left) send(p.ws, this.view(p));
  }

  // ----- déroulement -----
  spinWheel(title, names, ids, winnerIdx, final) {
    this.wheel = { id: ++this.wheelSeq, title, names, ids, winner: winnerIdx, final: !!final };
  }
  // Roue finale de 1 à 30 : toujours tournée à la fin de la partie, qu'il y ait 1 ou plusieurs perdants au départ
  finalWheel(loserId) {
    const name = this.players.find(p => p.id === loserId).name;
    const w = rnd(30);
    this.phase = 'final';
    this.spinWheel(name + ' : roue de 1 à 30', Array.from({ length: 30 }, (_, i) => String(i + 1)), [], w, true);
    this.say('Roue finale de 1 à 30 pour ' + name + '…');
    this.broadcast();
    this.later(TM.tie, () => {
      this.finalNum = w + 1; this.wheel = null;
      this.say(name + ' tire le ' + this.finalNum + ' !');
      this.phase = 'over'; this.broadcast();
    });
  }
  // Joueurs encore dans la roue : ceux qui n'ont pas encore distribué dans ce tour.
  // Quand tout le monde a distribué, nouveau tour : tous les joueurs reviennent dans la roue.
  dealerPool() {
    const active = this.players.filter(p => !p.left);
    let pool = active.filter(p => !this.dealt.has(p.id)), reset = false;
    if (!pool.length) {
      reset = true; this.dealt = new Set();
      pool = active;
    }
    if (!pool.length) pool = active.length ? active : this.players.slice();
    return { pool, reset };
  }
  start() {
    if (this.phase !== 'lobby' || this.players.length < MINP) return;
    clearTimeout(this.timer);
    this.round = 0; this.dealer = -1;
    for (const p of this.players) { p.bars = 0; p.hand = []; p.bid = null; p.won = 0; }
    this.results = null; this.tiebreak = null; this.loser = null; this.finalNum = null;
    this.dealt = new Set();
    const w = rnd(this.players.length);
    this.phase = 'wheel';
    this.spinWheel('Qui distribue en premier ?', this.players.map(p => p.name), this.players.map(p => p.id), w);
    this.say('La roue tourne pour choisir le premier distributeur…');
    this.broadcast();
    this.later(TM.wheel, () => { this.dealer = w; this.wheel = null; this.say(this.players[w].name + ' distribue'); this.beginRound(); });
  }
  beginRound() {
    this.round++; this.nCards = 0; this.trick = []; this.trickWinner = null; this.results = null;
    for (const p of this.players) { p.hand = []; p.bid = null; p.won = 0; }
    this.phase = 'choose'; this.turn = this.dealer;
    this.dealt.add(this.players[this.dealer].id);
    this.say('— Manche ' + this.round + '/' + this.totalRounds + ' : ' + this.players[this.dealer].name + ' choisit le nombre de cartes —');
    this.arm();
    this.broadcast();
  }
  arm() {
    clearTimeout(this.timer);
    const p = this.players[this.turn]; if (!p) return;
    const ms = (p.connected && !p.left) ? TM.turn : TM.off;
    this.deadline = Date.now() + ms;
    this.timer = setTimeout(() => this.auto(), ms);
  }
  auto() {
    const p = this.players[this.turn]; if (!p) return;
    if (this.phase === 'choose') { this.say(p.name + ' : temps écoulé'); this.choose(p, 1 + rnd(Math.min(this.maxChoose, 5))); }
    else if (this.phase === 'bid') {
      this.say(p.name + ' : temps écoulé');
      for (let x = 0; x <= this.nCards; x++) if (!this.bid(p, x)) break;
    } else if (this.phase === 'play') {
      this.say(p.name + ' : temps écoulé');
      const nums = p.hand.filter(c => c <= NUMS).sort((a, b) => a - b);
      if (nums.length) this.play(p, nums[0]); else this.play(p, p.hand[0], 'L');
    }
  }
  choose(p, n) {
    if (this.phase !== 'choose' || this.players[this.dealer] !== p) return 'Ce n\'est pas à toi de choisir';
    n = Math.floor(Number(n));
    if (!(n >= 1 && n <= this.maxChoose)) return 'Choisis entre 1 et ' + this.maxChoose + ' cartes';
    clearTimeout(this.timer);
    this.nCards = n;
    const deck = shuffled();
    for (const q of this.players) q.hand = deck.splice(0, n);
    this.say(p.name + ' distribue ' + n + ' carte' + (n > 1 ? 's' : '') + ' à chacun');
    this.phase = 'bid';
    this.turn = (this.dealer + 1) % this.players.length;
    this.arm(); this.broadcast();
    return null;
  }
  bid(p, x) {
    if (this.phase !== 'bid' || this.players[this.turn] !== p) return 'Ce n\'est pas ton tour';
    x = Math.floor(Number(x));
    if (!(x >= 0 && x <= this.nCards)) return 'Annonce entre 0 et ' + this.nCards;
    if (this.turn === this.dealer) {
      const sum = this.players.reduce((s, q) => s + (q !== p && q.bid !== null ? q.bid : 0), 0);
      if (sum + x === this.nCards) return 'Interdit : le total des annonces ne peut pas égaler ' + this.nCards;
    }
    clearTimeout(this.timer);
    p.bid = x; this.say(p.name + ' annonce ' + x);
    if (this.turn === this.dealer) {
      this.phase = 'play'; this.turn = (this.dealer + 1) % this.players.length; this.trick = [];
      this.say('Les annonces sont faites : on joue !');
    } else this.turn = (this.turn + 1) % this.players.length;
    this.arm(); this.broadcast();
    return null;
  }
  play(p, card, mode) {
    if (this.phase !== 'play' || this.players[this.turn] !== p) return 'Ce n\'est pas ton tour';
    card = Math.floor(Number(card));
    if (!p.hand.includes(card)) return 'Tu n\'as pas cette carte';
    if (card > NUMS && mode !== 'H' && mode !== 'L') return 'Choisis : Poulpe haut ou bas';
    clearTimeout(this.timer);
    p.hand.splice(p.hand.indexOf(card), 1);
    this.trick.push({ pid: p.id, card, mode: card > NUMS ? mode : null });
    if (card > NUMS) this.say(p.name + ' joue un Poulpe ' + (mode === 'H' ? '(le plus GRAND)' : '(le plus PETIT)'));
    if (this.trick.length < this.players.length) {
      this.turn = (this.turn + 1) % this.players.length;
      this.arm(); this.broadcast(); return null;
    }
    // pli complet
    const wi = trickWinnerIdx(this.trick);
    const winP = this.players.find(q => q.id === this.trick[wi].pid);
    winP.won++; this.trickWinner = winP.id;
    this.say(winP.name + ' remporte le pli');
    this.phase = 'trickEnd'; this.turn = -1;
    this.broadcast();
    this.later(TM.trick, () => {
      this.trick = []; this.trickWinner = null;
      if (this.players.every(q => q.hand.length === 0)) return this.endRound();
      this.phase = 'play'; this.turn = this.players.indexOf(winP);
      this.arm(); this.broadcast();
    });
    return null;
  }
  endRound() {
    // 1 barre par pli d'écart avec l'annonce (en plus ou en moins) : 5 annoncés, 3 réalisés = 2 barres
    this.results = this.players.map(p => { const d = Math.abs((p.bid || 0) - p.won); return { id: p.id, name: p.name, bid: p.bid, won: p.won, ok: d === 0, bars: d }; });
    for (const r of this.results) this.players.find(p => p.id === r.id).bars += r.bars;
    const ko = this.results.filter(r => !r.ok);
    this.say('Fin de la manche ' + this.round + ' : ' + (ko.length ? ko.map(r => r.name + ' +' + r.bars + ' barre' + (r.bars > 1 ? 's' : '')).join(', ') : 'personne ne prend de barre'));
    this.phase = 'roundEnd'; this.turn = -1;
    if (this.round >= this.totalRounds) {
      this.broadcast();
      return this.later(TM.round * 0.6, () => this.finishGame());
    }
    const { pool, reset } = this.dealerPool();
    const w = rnd(pool.length), next = pool[w];
    this.spinWheel(reset ? 'Nouveau tour : prochain distributeur' : 'Prochain distributeur', pool.map(p => p.name), pool.map(p => p.id), w);
    if (reset) this.say('Tout le monde a distribué : nouveau tour de roue');
    this.broadcast();
    this.later(TM.round, () => { this.dealer = this.players.indexOf(next); this.wheel = null; this.say(next.name + ' distribue'); this.beginRound(); });
  }
  finishGame() {
    this.results = null; this.wheel = null;
    const max = Math.max(...this.players.map(p => p.bars));
    const tied = this.players.filter(p => p.bars === max);
    if (tied.length === 1) { this.loser = tied[0].id; this.say(tied[0].name + ' a le plus de barres : c\'est le perdant !'); return this.finalWheel(this.loser); }
    // égalité : chaque joueur à égalité tire une carte ; le plus grand fait tourner la roue avec TOUS les joueurs à égalité (lui compris)
    const pool = Array.from({ length: NUMS }, (_, i) => i + 1);
    const draws = tied.map(p => ({ id: p.id, name: p.name, card: pool.splice(rnd(pool.length), 1)[0] }));
    const top = draws.reduce((a, b) => (b.card > a.card ? b : a));
    const w = rnd(tied.length);
    this.tiebreak = { draws, top: top.id, topName: top.name };
    this.phase = 'tiebreak';
    this.spinWheel(top.name + ' fait tourner la roue des égalités', tied.map(p => p.name), tied.map(p => p.id), w);
    this.say('Égalité à ' + max + ' barres : ' + draws.map(d => d.name + ' tire ' + d.card).join(', '));
    this.broadcast();
    this.later(TM.tie, () => {
      this.loser = tied[w].id; this.wheel = null;
      this.say(tied[w].name + ' perd la roue : c\'est le perdant !');
      this.finalWheel(this.loser);
    });
  }
  again() {
    if (this.phase !== 'over') return;
    clearTimeout(this.timer); clearTimeout(this.hold);
    this.players = this.players.filter(p => !p.left);
    for (const p of this.players) { p.hand = []; p.bid = null; p.won = 0; p.bars = 0; }
    this.phase = 'lobby'; this.round = 0; this.dealer = -1; this.turn = -1; this.nCards = 0;
    this.trick = []; this.results = null; this.tiebreak = null; this.loser = null; this.finalNum = null; this.wheel = null;
    this.dealt = new Set();
    if (!this.players.some(p => p.id === this.hostId) && this.players[0]) this.hostId = this.players[0].id;
    this.say('— Nouvelle partie —');
    this.broadcast();
  }
  removePlayer(p) {
    if (!this.inGame) {
      this.players = this.players.filter(x => x !== p);
      this.say(p.name + ' quitte la table');
    } else { p.left = true; p.connected = false; this.say(p.name + ' quitte la partie'); }
    if (this.hostId === p.id) {
      const h = this.players.find(x => x.connected && !x.left);
      this.hostId = h ? h.id : null;
    }
    this.broadcast();
    if (this.inGame && this.turn >= 0 && this.players[this.turn] === p) this.arm();
  }
}

// ----- messages -----
wss.on('connection', ws => {
  ws.isAlive = true; ws.msgs = 0;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    if (++ws.msgs > 40) return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    try { handle(ws, m); } catch (e) { console.error(e); }
  });
  ws.on('close', () => {
    const p = ws.player, room = ws.room;
    if (p && room && p.ws === ws) {
      p.connected = false;
      if (!room.inGame) { room.players = room.players.filter(x => x !== p); room.say(p.name + ' quitte la table'); if (room.hostId === p.id) { const h = room.players[0]; room.hostId = h ? h.id : null; } }
      else {
        room.say(p.name + ' est déconnecté');
        if (room.players[room.turn] === p) room.arm();
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
      const code = genCode(); room = new Room(code); rooms.set(code, room);
    } else {
      room = rooms.get(String(m.code || '').toUpperCase().trim());
      if (!room) return send(ws, { t: 'err', msg: 'Table introuvable', fatal: !!m.token });
    }
    const p = room.addPlayer(ws, String(m.name || ''), m.token);
    if (p.error) return send(ws, { t: 'err', msg: p.error, fatal: !!m.token });
    ws.player = p; ws.room = room;
    send(ws, { t: 'joined', code: room.code, token: p.token, name: p.name });
    room.broadcast();
    return;
  }
  const p = ws.player, room = ws.room;
  if (!p || !room) return;
  let e = null;
  if (m.t === 'rounds') {
    if (room.hostId !== p.id || room.phase !== 'lobby') return;
    const n = Math.floor(Number(m.n));
    if (n >= 1 && n <= 30) { room.totalRounds = n; room.broadcast(); }
  } else if (m.t === 'start') {
    if (room.hostId !== p.id) e = 'Seul l\'hôte peut lancer la partie';
    else if (room.players.length < MINP) e = 'Il faut au moins ' + MINP + ' joueurs';
    else room.start();
  } else if (m.t === 'choose') e = room.choose(p, m.n);
  else if (m.t === 'bid') e = room.bid(p, m.n);
  else if (m.t === 'play') e = room.play(p, m.card, m.mode);
  else if (m.t === 'again') { if (room.hostId === p.id) room.again(); }
  else if (m.t === 'chat') {
    const text = String(m.text || '').slice(0, 200).trim();
    if (text) for (const q of room.players) if (q.connected && !q.left) send(q.ws, { t: 'chat', name: p.name, text });
  } else if (m.t === 'leave') {
    room.removePlayer(p); ws.player = null; ws.room = null; send(ws, { t: 'left' });
  }
  if (e) send(ws, { t: 'err', msg: e });
}

setInterval(() => { for (const ws of wss.clients) ws.msgs = 0; }, 1000);
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); }
  const now = Date.now();
  for (const [c, r] of rooms) {
    if (!r.players.some(p => p.connected && !p.left) && now - r.lastSeen > 10 * 60 * 1000) {
      clearTimeout(r.timer); clearTimeout(r.hold); rooms.delete(c);
    }
  }
}, 25000);

module.exports = { wss, rooms, Room, trickWinnerIdx };
