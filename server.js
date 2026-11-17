const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { Server } = require('socket.io');

// ===== POSTAVKE =====
const PORT = process.env.PORT || 3000;
const HOST_PIN = process.env.HOST_PIN || 'stepski'; // na Renderu postavi HOST_PIN u Environment
const START_LIVES = 3;   // broj života prije ispadanja
const PENALTY = 0.5;     // netačan odgovor oduzima ovaj dio bodova pitanja (0.5 = polovinu)

// ===== PITANJA (host ih može dodavati i u samoj igri) =====
let questions = [
  { q: 'Ko je autor romana "Stepski vuk"?', a: 'Hermann Hesse', points: 100 },
  { q: 'Koje godine je roman prvi put objavljen?', a: '1927.', points: 100 },
  { q: 'Kako se zove glavni lik romana?', a: 'Harry Haller', points: 100 },
  { q: 'Šta simbolizira "stepski vuk" u romanu?', a: 'Usamljenika otuđenog od društva i građanskog života', points: 200 },
  { q: 'Koje dvije "duše" se bore u Harryju?', a: 'Čovjek i vuk', points: 200 },
  { q: 'Šta Harry planira učiniti na svoj 50. rođendan?', a: 'Oduzeti sebi život', points: 200 },
  { q: 'Ko je Hermine?', a: 'Mlada žena koja ga uči plesati i uživati u životu', points: 300 },
  { q: 'Čime se bavi Pablo?', a: 'Svira saksofon', points: 300 },
  { q: 'Šta piše na ulazu u Magično kazalište?', a: 'Samo za lude', points: 300 },
  { q: 'Ko objavljuje Harryjeve zapise?', a: 'Nećak njegove stanodavke', points: 400 },
  { q: 'Koga Harry u Magičnom kazalištu sreće kao uzor humora i životne lakoće?', a: 'Mozarta', points: 400 },
  { q: 'Šta Harry uradi Hermine u Magičnom kazalištu?', a: 'Ubode je nožem', points: 500 },
  { q: 'Kojom nagradom je Hesse nagrađen 1946. godine?', a: 'Nobelovom za književnost', points: 500 }
].map(x => ({ ...x, used: false }));

// ===== STANJE =====
let players = {}; // id -> { id, name, score, lives, out, online, sid }
let round = freshRound();

function freshRound() {
  return { phase: 'idle', qi: -1, queue: [], locked: [], hostReveal: false, result: '', note: '' };
}

function sortedPlayers() {
  return Object.values(players).sort(
    (a, b) => (a.out - b.out) || (b.score - a.score) || a.name.localeCompare(b.name)
  );
}

function snapshot(forHost) {
  const q = questions[round.qi];
  const showAnswer = q && (round.phase === 'done' || (forHost && round.hostReveal));
  const s = {
    startLives: START_LIVES,
    players: sortedPlayers().map(p => ({
      id: p.id, name: p.name, score: p.score, lives: p.lives, out: p.out, online: p.online
    })),
    round: {
      phase: round.phase,
      points: q ? q.points : 0,
      queue: round.queue,
      locked: round.locked,
      result: round.result,
      note: round.note,
      answer: showAnswer ? q.a : null,
      question: forHost && q ? q.q : null
    }
  };
  if (forHost) {
    s.questions = questions.map(x => ({ q: x.q, points: x.points, used: x.used }));
    s.qi = round.qi;
  }
  return s;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (_req, res) => res.send('ok'));

function broadcast() {
  for (const [, s] of io.sockets.sockets) {
    s.emit('state', snapshot(s.data.role === 'host'));
  }
}

function checkNoEligible() {
  if (round.phase !== 'open' || round.queue.length > 0) return;
  const eligible = Object.values(players).some(p => !p.out && !round.locked.includes(p.id));
  if (!eligible) {
    round.phase = 'done';
    round.result = 'Niko nije pogodio.';
  }
}

io.on('connection', socket => {
  socket.emit('state', snapshot(false));

  // ----- igrač -----
  socket.on('player:join', (d = {}) => {
    const name = String(d.name || '').trim().slice(0, 20);
    if (!name) return socket.emit('err', 'Upiši ime.');
    let p = d.id && players[d.id];
    if (!p) {
      p = Object.values(players).find(x => x.name.toLowerCase() === name.toLowerCase());
      if (p && p.online) return socket.emit('err', 'To ime je već zauzeto.');
    }
    if (!p) {
      p = { id: crypto.randomBytes(4).toString('hex'), name, score: 0, lives: START_LIVES, out: false, online: true, sid: socket.id };
      players[p.id] = p;
    }
    p.online = true;
    p.sid = socket.id;
    socket.data.role = 'player';
    socket.data.pid = p.id;
    socket.emit('joined', { id: p.id, name: p.name });
    broadcast();
  });

  socket.on('player:buzz', () => {
    const p = players[socket.data.pid];
    if (!p || p.out || round.phase !== 'open') return;
    if (round.queue.includes(p.id) || round.locked.includes(p.id)) return;
    round.queue.push(p.id);
    broadcast();
  });

  // ----- prikaz liste -----
  socket.on('display:join', () => {
    socket.data.role = 'display';
    broadcast();
  });

  // ----- host -----
  socket.on('host:join', pin => {
    if (pin === HOST_PIN) {
      socket.data.role = 'host';
      socket.emit('host:ok');
      broadcast();
    } else {
      socket.emit('host:bad');
    }
  });

  const H = fn => (...args) => {
    if (socket.data.role !== 'host') return;
    fn(...args);
    broadcast();
  };

  socket.on('host:pick', H(i => {
    const q = questions[i];
    if (!q) return;
    q.used = true;
    round = { ...freshRound(), phase: 'ready', qi: i };
  }));

  socket.on('host:open', H(() => {
    if (round.phase === 'ready') round.phase = 'open';
  }));

  socket.on('host:reveal', H(() => {
    round.hostReveal = true;
  }));

  socket.on('host:correct', H(() => {
    const q = questions[round.qi];
    const p = players[round.queue[0]];
    if (!p || !q || round.phase !== 'open') return;
    p.score += q.points;
    round.result = `${p.name} je odgovorio/la tačno (+${q.points})`;
    round.phase = 'done';
    round.queue = [];
    round.note = '';
  }));

  socket.on('host:wrong', H(() => {
    const q = questions[round.qi];
    const p = players[round.queue[0]];
    if (!p || !q || round.phase !== 'open') return;
    const loss = Math.round(q.points * PENALTY);
    p.score -= loss;
    p.lives -= 1;
    if (p.lives <= 0) { p.lives = 0; p.out = true; }
    round.queue.shift();
    round.locked.push(p.id);
    round.note = `${p.name}: netačno (−${loss})${p.out ? ' i ispada iz igre' : ''}`;
    checkNoEligible();
  }));

  socket.on('host:skip', H(() => {
    if (round.phase !== 'ready' && round.phase !== 'open') return;
    round.phase = 'done';
    round.result = 'Pitanje preskočeno, niko nije dobio bodove.';
    round.queue = [];
  }));

  socket.on('host:addq', H(d => {
    d = d || {};
    const q = String(d.q || '').trim().slice(0, 300);
    const a = String(d.a || '').trim().slice(0, 300);
    const points = Math.max(1, parseInt(d.points, 10) || 100);
    if (q && a) questions.push({ q, a, points, used: false });
  }));

  socket.on('host:adjust', H((id, delta) => {
    const p = players[id];
    if (p) p.score += parseInt(delta, 10) || 0;
  }));

  socket.on('host:revive', H(id => {
    const p = players[id];
    if (p) { p.out = false; p.lives = START_LIVES; }
  }));

  socket.on('host:kick', H(id => {
    delete players[id];
    round.queue = round.queue.filter(x => x !== id);
    round.locked = round.locked.filter(x => x !== id);
    checkNoEligible();
  }));

  socket.on('host:reset', H(() => {
    Object.values(players).forEach(p => { p.score = 0; p.lives = START_LIVES; p.out = false; });
    questions.forEach(q => { q.used = false; });
    round = freshRound();
  }));

  socket.on('disconnect', () => {
    const p = players[socket.data.pid];
    if (p && p.sid === socket.id) p.online = false;
    broadcast();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Kviz radi na portu ' + PORT);
  console.log('  Na ovom računaru: http://localhost:' + PORT);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) console.log('  Na istoj Wi-Fi mreži: http://' + i.address + ':' + PORT);
    }
  }
});
