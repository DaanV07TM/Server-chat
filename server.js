const express = require('express');
const http = require('http');
const crypto = require('crypto');
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

// beheer: wachtwoord staat in Render (ADMIN_PASSWORD), niet in de code
const ADMIN = process.env.ADMIN_PASSWORD || '';
let offline = process.env.MAINTENANCE === '1';
let fails = [];
let slow = 0;               // slowmode in seconden (0 = uit)
let maintTimers = [];
const ADMIN_CMDS = ['/status', '/offline', '/online', '/wis', '/omroep', '/onderhoud', '/slow', '/herstart', '/uit'];
const ADMIN_HELP = "Commando's: /status /offline /online /wis /omroep tekst /onderhoud minuten /slow seconden /herstart /uit";
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
function login(pw) {
  if (!ADMIN) return 'nopw';
  const now = Date.now();
  fails = fails.filter(t => now - t < 10 * 60 * 1000);
  if (fails.length >= 5) return 'locked';
  if (crypto.timingSafeEqual(sha(pw), sha(ADMIN))) return 'ok';
  fails.push(now);
  console.log('[admin] foute inlogpoging');
  return 'bad';
}
const LOGIN_MSG = {
  nopw: 'ADMIN_PASSWORD is nog niet ingesteld op Render.',
  locked: 'Te veel foute pogingen. Probeer het over 10 minuten opnieuw.',
  bad: 'Fout wachtwoord.'
};

const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);
const roomName = (s) => clean(s, 30).toLowerCase().replace(/[^a-z0-9-_]/g, '') || 'algemeen';
const IMG = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+\/=]+$/;

function store(room, m) {
  if (!rooms[room]) console.log('[kamer] nieuwe kamer actief');
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

// beheerderscommando's (alleen na /admin <wachtwoord>), antwoord gaat alleen naar de beheerder
const statsLine = () =>
  'online: ' + io.engine.clientsCount + ' | kamers: ' + Object.keys(rooms).length +
  ' | berichten: ' + Object.values(rooms).reduce((n, l) => n + l.length, 0) +
  ' | chat: ' + (offline ? 'OFFLINE' : 'online') + (slow ? ' | slowmode: ' + slow + 's' : '') + (maintTimers.length ? ' | onderhoud gepland' : '');

const announce = (t) => io.emit('msg', { name: '📢', bot: true, text: t, t: Date.now() });
const cancelMaint = () => { maintTimers.forEach(clearTimeout); maintTimers = []; };
function goOffline() {
  offline = true;
  console.log('[admin] chat staat nu OFFLINE');
  for (const [, s] of io.sockets.sockets) if (!s.data.admin) s.emit('closed', true);
}

function adminCommand(socket, c, arg) {
  const say = (t) => socket.emit('sys', t);
  if (c === 'status') say(statsLine());
  else if (c === 'offline') {
    cancelMaint();
    goOffline();
    say('Chat is offline. Typ /online om hem weer aan te zetten.');
  } else if (c === 'online') {
    cancelMaint();
    offline = false;
    console.log('[admin] chat staat nu ONLINE');
    io.emit('closed', false);
    say('Chat is weer online.');
  } else if (c === 'wis') {
    for (const r in rooms) delete rooms[r];
    console.log('[admin] alle berichten gewist');
    io.emit('history', []);
    say('Alle berichten gewist.');
  } else if (c === 'omroep') {
    if (!arg) return say('Gebruik: /omroep je bericht');
    announce(clean(arg, 300));
    console.log('[admin] omroep verstuurd');
  } else if (c === 'onderhoud') {
    const n = parseInt(arg);
    if (!n || n < 1 || n > 120) return say('Gebruik: /onderhoud 10 (aantal minuten, 1 tot 120). Annuleren kan met /online.');
    cancelMaint();
    announce('🔧 Onderhoud: de chat gaat over ' + n + (n === 1 ? ' minuut' : ' minuten') + ' offline.');
    if (n > 1) maintTimers.push(setTimeout(() => announce('🔧 Nog 1 minuut tot de chat offline gaat.'), (n - 1) * 60000));
    maintTimers.push(setTimeout(() => { maintTimers = []; announce('🔧 De chat gaat nu offline voor onderhoud.'); goOffline(); }, n * 60000));
    console.log('[admin] onderhoud gepland over ' + n + ' min');
    say('Onderhoud gepland over ' + n + ' min. Annuleren: /online');
  } else if (c === 'slow') {
    const n = parseInt(arg);
    if (isNaN(n) || n < 0 || n > 60) return say('Gebruik: /slow 5 (seconden tussen berichten, 0 = uit)');
    slow = n;
    console.log('[admin] slowmode ' + n + 's');
    announce(n ? '🐢 Slowmode aan: 1 bericht per ' + n + ' seconden.' : '🐢 Slowmode uit.');
  } else if (c === 'herstart') {
    say('Server herstart nu. Render start hem automatisch weer op (duurt ongeveer een minuut).');
    console.log('[admin] herstart aangevraagd');
    setTimeout(() => process.exit(0), 500);
  } else if (c === 'uit') {
    socket.data.admin = false;
    say('Uitgelogd als beheerder.');
  } else say(ADMIN_HELP);
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

setInterval(() => console.log('[stats] ' + statsLine()), 10 * 60 * 1000);

io.on('connection', (socket) => {
  console.log('[online] ' + io.engine.clientsCount);
  let room = 'algemeen';
  let last = 0;
  const blocked = () => offline && !socket.data.admin;

  socket.on('join', (name) => {
    room = roomName(name);
    socket.join(room);
    if (blocked()) return socket.emit('closed', true);
    const now = Date.now();
    socket.emit('history', (rooms[room] || []).filter(m => now - m.t < TTL));
    io.to(room).emit('online', io.sockets.adapter.rooms.get(room)?.size || 1);
  });

  socket.on('msg', (d) => {
    const now = Date.now();
    const gap = socket.data.admin ? 500 : Math.max(500, slow * 1000);
    if (now - last < gap) {
      if (slow && !socket.data.admin && now - last >= 500) socket.emit('sys', 'Slowmode: wacht nog even.');
      return;
    }
    const name = clean(d && d.name, 20) || 'Anoniem';
    const text = clean(d && d.text, 500);

    if (text === '/admin' || text.startsWith('/admin ')) {   // wachtwoord wordt nooit getoond of opgeslagen
      last = now;
      const r = login(text.slice(6).trim());
      if (r === 'ok') { socket.data.admin = true; socket.emit('sys', 'Ingelogd als beheerder. ' + ADMIN_HELP); }
      else socket.emit('sys', LOGIN_MSG[r]);
      return;
    }
    const [cmd, ...rest] = text.split(' ');
    if (socket.data.admin && ADMIN_CMDS.includes(cmd)) {
      last = now;
      return adminCommand(socket, cmd.slice(1), rest.join(' ').trim());
    }

    if (offline) return;   // tijdens offline wordt er niets doorgestuurd, ook niet van de beheerder
    const img = d && typeof d.img === 'string' && d.img.length < 1.4e6 && IMG.test(d.img) ? d.img : null;
    if (!text && !img) return;
    last = now;
    const m = { id: socket.id, name, text, t: now };
    if (img) m.img = img;
    store(room, m);
    io.to(room).emit('msg', m);
    if (text[0] === '/') command(room, name, text);
  });

  socket.on('typing', (n) => { if (!blocked()) socket.to(room).emit('typing', clean(n, 20)); });

  socket.on('game:open', () => {
    if (blocked()) return;
    const g = game(room);
    if (!g.p.X) g.p.X = socket.id;
    else if (!g.p.O && g.p.X !== socket.id) g.p.O = socket.id;
    pushGame(room);
  });

  socket.on('game:move', (i) => {
    if (blocked()) return;
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
    if (blocked()) return;
    const g = game(room);
    if (g.p.X !== socket.id && g.p.O !== socket.id) return;
    g.b = Array(9).fill(''); g.turn = 'X'; g.w = null;
    pushGame(room);
  });

  socket.on('disconnect', () => {
    console.log('[online] ' + io.engine.clientsCount);
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
server.listen(PORT, () => console.log('Chat draait op poort ' + PORT + (offline ? ' (offline-modus)' : '') + (ADMIN ? '' : ' | let op: ADMIN_PASSWORD is niet ingesteld')));
