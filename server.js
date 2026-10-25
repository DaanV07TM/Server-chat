const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2e6 });
app.use(express.static('public'));

const MAX_MSGS = 50;          // berichten per kamer
const MAX_IMGS = 8;           // afbeeldingen per kamer (geheugen sparen)
const TTL = 60 * 60 * 1000;   // berichten verdwijnen na 1 uur
const rooms = {};             // alles alleen in het geheugen, geen IP's
const games = {};

const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);
const roomName = (s) => clean(s, 30).toLowerCase().replace(/[^a-z0-9-_]/g, '') || 'algemeen';
const IMG = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+\/=]+$/;

function store(room, m) {
  const list = (rooms[room] ||= []);
  list.push(m);
  if (list.length > MAX_MSGS) list.shift();
  const withImg = list.filter(x => x.img);
  while (withImg.length > MAX_IMGS) {
    const o = withImg.shift();
    delete o.img;
    o.text = o.text || '(afbeelding verwijderd)';
  }
}

function bot(room, text) {
  const m = { name: 'Bot', bot: true, text, t: Date.now() };
  store(room, m);
  io.to(room).emit('msg', m);
}

const BALL = ['Ja', 'Nee', 'Misschien', 'Zeker weten', 'Zeker niet', 'Vraag het later nog eens', 'Ziet er goed uit', 'Ik betwijfel het'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

function command(room, name, text) {
  const [c, ...r] = text.slice(1).split(' ');
  const arg = r.join(' ').trim();
  if (c === 'dobbel') {
    const n = Math.min(Math.max(parseInt(arg) || 6, 2), 1000);
    bot(room, `🎲 ${name} gooit een d${n}: ${1 + Math.floor(Math.random() * n)}`);
  } else if (c === 'munt') {
    bot(room, `🪙 ${name} gooit een munt: ${Math.random() < 0.5 ? 'kop' : 'munt'}`);
  } else if (c === '8ball') {
    bot(room, `🎱 ${arg || '...'} → ${pick(BALL)}`);
  }
}

// boter-kaas-en-eieren
const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const game = (room) => (games[room] ||= { b: Array(9).fill(''), turn: 'X', p: { X: null, O: null }, w: null });
const pushGame = (room) => io.to(room).emit('game', game(room));

setInterval(() => {
  const now = Date.now();
  for (const r in rooms) {
    rooms[r] = rooms[r].filter(m => now - m.t < TTL);
    if (!rooms[r].length) delete rooms[r];
  }
}, 60 * 1000);

io.on('connection', (socket) => {
  let room = 'algemeen';
  let last = 0;

  socket.on('join', (name) => {
    room = roomName(name);
    socket.join(room);
    const now = Date.now();
    socket.emit('history', (rooms[room] || []).filter(m => now - m.t < TTL));
    io.to(room).emit('online', io.sockets.adapter.rooms.get(room)?.size || 1);
  });

  socket.on('msg', (d) => {
    const now = Date.now();
    if (now - last < 500) return;
    const name = clean(d && d.name, 20) || 'Anoniem';
    const text = clean(d && d.text, 500);
    const img = d && typeof d.img === 'string' && d.img.length < 1.4e6 && IMG.test(d.img) ? d.img : null;
    if (!text && !img) return;
    last = now;
    const m = { id: socket.id, name, text, t: now };
    if (img) m.img = img;
    store(room, m);
    io.to(room).emit('msg', m);
    if (text[0] === '/') command(room, name, text);
  });

  socket.on('typing', (n) => socket.to(room).emit('typing', clean(n, 20)));

  socket.on('game:open', () => {
    const g = game(room);
    if (!g.p.X) g.p.X = socket.id;
    else if (!g.p.O && g.p.X !== socket.id) g.p.O = socket.id;
    pushGame(room);
  });

  socket.on('game:move', (i) => {
    const g = game(room);
    const s = g.p.X === socket.id ? 'X' : g.p.O === socket.id ? 'O' : null;
    if (!s || g.w || g.turn !== s || !Number.isInteger(i) || i < 0 || i > 8 || g.b[i]) return;
    g.b[i] = s;
    if (LINES.some(l => l.every(k => g.b[k] === s))) g.w = s;
    else if (g.b.every(Boolean)) g.w = 'gelijk';
    else g.turn = s === 'X' ? 'O' : 'X';
    pushGame(room);
  });

  socket.on('game:reset', () => {
    const g = game(room);
    if (g.p.X !== socket.id && g.p.O !== socket.id) return;
    g.b = Array(9).fill(''); g.turn = 'X'; g.w = null;
    pushGame(room);
  });

  socket.on('disconnect', () => {
    io.to(room).emit('online', io.sockets.adapter.rooms.get(room)?.size || 0);
    const g = games[room];
    if (g) {
      if (g.p.X === socket.id) g.p.X = null;
      if (g.p.O === socket.id) g.p.O = null;
      if (!g.p.X && !g.p.O) delete games[room]; else pushGame(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Chat draait op poort ' + PORT));
