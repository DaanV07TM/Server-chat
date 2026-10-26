const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2e6 });
app.use(express.static('public'));

const MAX_MSGS = 50, MAX_IMGS = 8, TTL = 60 * 60 * 1000, REPORT_LIMIT = 3;
const rooms = {}, games = {}, timeouts = {}, strikes = {};   // everything lives in memory only; no IPs, no accounts

// in-memory event log (readable in chat with /log)
const events = [];
const _log = console.log;
console.log = (...a) => {
  _log(...a);
  const line = a.join(' ');
  if (!line.startsWith('[online]')) { events.push(new Date().toISOString().slice(11, 19) + ' ' + line); if (events.length > 30) events.shift(); }
};

// admin: password lives in Render (ADMIN_PASSWORD), never in the code
const ADMIN = process.env.ADMIN_PASSWORD || '';
let offline = process.env.MAINTENANCE === '1';
let silenced = false, slow = 0, links = false, images = 'private';   // images: off | private | on
let banned = [], fails = [], maintTimers = [], midCount = 0;
const ADMIN_CMDS = ['/status', '/offline', '/online', '/wipe', '/clear', '/announce', '/maintenance', '/slow', '/restart', '/silence', '/block', '/unblock', '/log', '/reports', '/delete', '/timeout', '/pardon', '/links', '/images', '/logout'];
const ADMIN_HELP = "Commands: /status /offline /online /wipe /clear /announce text /maintenance minutes /slow seconds /silence /block word /unblock word /reports /delete id /timeout id minutes /pardon /links on|off /images off|private|on /log /restart /logout";

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
function login(pw) {
  if (!ADMIN) return 'nopw';
  const now = Date.now();
  fails = fails.filter(t => now - t < 10 * 60 * 1000);
  if (fails.length >= 5) return 'locked';
  if (crypto.timingSafeEqual(sha(pw), sha(ADMIN))) return 'ok';
  fails.push(now);
  console.log('[admin] failed login');
  return 'bad';
}
const LOGIN_MSG = { nopw: 'ADMIN_PASSWORD is not set on Render yet.', locked: 'Too many failed attempts. Try again in 10 minutes.', bad: 'Wrong password.' };

const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);
const roomName = (s) => clean(s, 30).toLowerCase().replace(/[^a-z0-9-_]/g, '') || 'general';
const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mask = (t) => banned.reduce((x, w) => x.replace(new RegExp(esc(w), 'gi'), '***'), t);
const safeName = (n) => { const x = mask(clean(n, 20)); return !x || /admin|moderator|^mod$|staff/i.test(x) ? 'Anon' : x; };
const IMG = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+\/=]+$/;
const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|gg|ly|me|xyz|ru|cn|tk|ml|ga|cf|gq|co|info|biz|app|dev|link|click|top)\b)/i;
const imagesAllowed = (room) => images === 'on' || (images === 'private' && room.startsWith('private-'));
const EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
const pub = (m) => { const { v, rep, tok, ...rest } = m; return rest; };

function store(room, m) {
  if (!m.mid) { m.mid = ++midCount; m.v = {}; m.r = {}; m.rep = []; }
  if (!rooms[room]) console.log('[room] new room active');
  const list = (rooms[room] ||= []);
  list.push(m);
  if (list.length > MAX_MSGS) list.shift();
  const withImg = list.filter(x => x.img);
  while (withImg.length > MAX_IMGS) { const o = withImg.shift(); delete o.img; o.text = o.text || '(image removed)'; }
}
function bot(room, text) {
  const m = { name: 'Bot', bot: true, text, t: Date.now() };
  store(room, m);
  io.to(room).emit('msg', pub(m));
}
const announce = (t) => io.emit('msg', { name: '📢', bot: true, text: t, t: Date.now() });
const adminSay = (t) => { for (const [, s] of io.sockets.sockets) if (s.data.admin) s.emit('sys', t); };
function removeMsg(mid) {
  for (const r in rooms) {
    const i = rooms[r].findIndex(m => m.mid === mid);
    if (i >= 0) { const [m] = rooms[r].splice(i, 1); io.to(r).emit('removed', mid); return m; }
  }
}
function strike(tok) {
  strikes[tok] = (strikes[tok] || 0) + 1;
  if (strikes[tok] >= 2) { timeouts[tok] = Date.now() + 10 * 60000; strikes[tok] = 0; console.log('[mod] automatic 10 min timeout'); }
}
const left = (until) => { const s = Math.ceil((until - Date.now()) / 1000); return s > 90 ? Math.ceil(s / 60) + ' min' : s + ' s'; };

const BALL = ['Yes', 'No', 'Maybe', 'Definitely', 'Definitely not', 'Ask again later', 'Looks good', 'I doubt it'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
function command(room, name, text) {
  const [c, ...r] = text.slice(1).split(' ');
  const arg = r.join(' ').trim();
  if (c === 'roll') bot(room, `🎲 ${name} rolls a d${Math.min(Math.max(parseInt(arg) || 6, 2), 1000)}: ` + (1 + Math.floor(Math.random() * Math.min(Math.max(parseInt(arg) || 6, 2), 1000))));
  else if (c === 'coin') bot(room, `🪙 ${name} flips a coin: ${Math.random() < 0.5 ? 'heads' : 'tails'}`);
  else if (c === '8ball') bot(room, `🎱 ${arg || '...'} → ${pick(BALL)}`);
  else if (c === 'rules') bot(room, 'Be kind. No harassment, hate, threats, scams or illegal content. Use ⚑ to report a message.');
}

const statsLine = () =>
  'online: ' + io.engine.clientsCount + ' | rooms: ' + Object.keys(rooms).length +
  ' | messages: ' + Object.values(rooms).reduce((n, l) => n + l.length, 0) +
  ' | chat: ' + (offline ? 'OFFLINE' : 'online') + ' | images: ' + images + ' | links: ' + (links ? 'on' : 'blocked') +
  (slow ? ' | slow: ' + slow + 's' : '') + (silenced ? ' | SILENCED' : '') + (maintTimers.length ? ' | maintenance planned' : '') +
  ' | timeouts: ' + Object.values(timeouts).filter(t => t > Date.now()).length +
  ' | memory: ' + Math.round(process.memoryUsage().rss / 1048576) + ' MB';
const cancelMaint = () => { maintTimers.forEach(clearTimeout); maintTimers = []; };
function goOffline() {
  offline = true;
  console.log('[admin] chat is now OFFLINE');
  for (const [, s] of io.sockets.sockets) if (!s.data.admin) s.emit('closed', true);
}

function adminCommand(socket, c, arg, room) {
  const say = (t) => socket.emit('sys', t);
  const num = parseInt(arg);
  if (c === 'status') say(statsLine());
  else if (c === 'offline') { cancelMaint(); goOffline(); say('Chat is offline. Type /online to bring it back.'); }
  else if (c === 'online') { cancelMaint(); offline = false; console.log('[admin] chat is now ONLINE'); io.emit('closed', false); say('Chat is back online.'); }
  else if (c === 'wipe') { for (const r in rooms) delete rooms[r]; console.log('[admin] all messages wiped'); io.emit('history', []); say('All messages wiped.'); }
  else if (c === 'clear') { delete rooms[room]; console.log('[admin] a room was cleared'); io.to(room).emit('history', []); say('This room was cleared.'); }
  else if (c === 'announce') { if (!arg) return say('Usage: /announce your message'); announce(clean(arg, 300)); console.log('[admin] announcement sent'); }
  else if (c === 'maintenance') {
    if (!num || num < 1 || num > 120) return say('Usage: /maintenance 10 (minutes, 1-120). Cancel with /online.');
    cancelMaint();
    announce('🔧 Maintenance: the chat goes offline in ' + num + (num === 1 ? ' minute.' : ' minutes.'));
    if (num > 1) maintTimers.push(setTimeout(() => announce('🔧 One minute until the chat goes offline.'), (num - 1) * 60000));
    maintTimers.push(setTimeout(() => { maintTimers = []; announce('🔧 The chat is going offline for maintenance now.'); goOffline(); }, num * 60000));
    console.log('[admin] maintenance planned in ' + num + ' min');
    say('Maintenance planned in ' + num + ' min. Cancel with /online.');
  }
  else if (c === 'slow') {
    if (isNaN(num) || num < 0 || num > 60) return say('Usage: /slow 5 (seconds between messages, 0 = off)');
    slow = num; console.log('[admin] slow mode ' + num + 's');
    announce(num ? '🐢 Slow mode on: 1 message per ' + num + ' seconds.' : '🐢 Slow mode off.');
  }
  else if (c === 'silence') { silenced = !silenced; console.log('[admin] silence ' + (silenced ? 'on' : 'off')); announce(silenced ? '🔇 Only moderators can send messages right now.' : '🔊 Everyone can chat again.'); }
  else if (c === 'block') {
    const w = clean(arg, 30).toLowerCase();
    if (!w) return say('Blocked words: ' + (banned.join(', ') || 'none') + ' | Usage: /block word');
    if (!banned.includes(w)) banned.push(w);
    say('Blocked: ' + w + ' (shown as ***)');
  }
  else if (c === 'unblock') { banned = banned.filter(x => x !== clean(arg, 30).toLowerCase()); say('Blocked words: ' + (banned.join(', ') || 'none')); }
  else if (c === 'links') { if (arg !== 'on' && arg !== 'off') return say('Usage: /links on|off (currently ' + (links ? 'on' : 'blocked') + ')'); links = arg === 'on'; say('Links are now ' + (links ? 'allowed' : 'blocked') + '.'); }
  else if (c === 'images') {
    if (!['off', 'private', 'on'].includes(arg)) return say('Usage: /images off|private|on (currently ' + images + ')');
    images = arg; io.emit('closed', false); say('Images: ' + images + (images === 'on' ? ' (public rooms are NOT scanned, be careful)' : ''));
  }
  else if (c === 'reports') {
    const out = [];
    for (const r in rooms) for (const m of rooms[r]) if (m.rep && m.rep.length) out.push('#' + m.mid + ' ' + m.name + ': "' + (m.text || '[image]').slice(0, 60) + '" (' + m.rep.length + ' reports)');
    say(out.slice(-8).join('\n') || 'No reported messages.');
  }
  else if (c === 'delete') { const m = removeMsg(num); say(m ? 'Message #' + num + ' deleted.' : 'Message not found.'); }
  else if (c === 'timeout') {
    const [id, min] = arg.split(' ').map(x => parseInt(x));
    const m = removeMsg(id);
    if (!m || !m.tok) return say('Usage: /timeout id minutes (message not found or has no author).');
    timeouts[m.tok] = Date.now() + Math.min(Math.max(min || 10, 1), 1440) * 60000;
    console.log('[mod] timeout set by admin');
    say('Author of #' + id + ' timed out for ' + Math.min(Math.max(min || 10, 1), 1440) + ' min. Message removed.');
  }
  else if (c === 'pardon') { for (const k in timeouts) delete timeouts[k]; for (const k in strikes) delete strikes[k]; say('All timeouts and strikes cleared.'); }
  else if (c === 'log') say(events.slice(-12).join('\n') || 'Nothing logged yet.');
  else if (c === 'restart') { say('Restarting. Render starts the server again automatically (about a minute).'); console.log('[admin] restart requested'); setTimeout(() => process.exit(0), 500); }
  else if (c === 'logout') { socket.data.admin = false; say('Logged out as moderator.'); }
  else say(ADMIN_HELP);
}

// tic-tac-toe
const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const game = (room) => (games[room] ||= { b: Array(9).fill(''), turn: 'X', p: { X: null, O: null }, w: null });
const pushGame = (room) => io.to(room).emit('game', game(room));

setInterval(() => {
  const now = Date.now();
  for (const r in rooms) { rooms[r] = rooms[r].filter(m => now - m.t < TTL); if (!rooms[r].length) delete rooms[r]; }
  for (const k in timeouts) if (timeouts[k] < now) delete timeouts[k];
}, 60 * 1000);
setInterval(() => { for (const k in strikes) delete strikes[k]; }, 60 * 60 * 1000);
setInterval(() => console.log('[stats] ' + statsLine()), 10 * 60 * 1000);

io.on('connection', (socket) => {
  console.log('[online] ' + io.engine.clientsCount);
  let room = 'general', last = 0, lastReact = 0, lastText = '', lastTextAt = 0, recent = [];
  const blocked = () => offline && !socket.data.admin;
  const key = () => socket.data.tok || socket.id;

  socket.on('join', (d) => {
    room = roomName(d && d.room);
    socket.data.tok = clean(d && d.tok, 32);
    socket.join(room);
    socket.emit('config', { images: imagesAllowed(room) });
    if (blocked()) return socket.emit('closed', true);
    const now = Date.now();
    socket.emit('history', (rooms[room] || []).filter(m => now - m.t < TTL).map(pub));
    io.to(room).emit('online', io.sockets.adapter.rooms.get(room)?.size || 1);
  });

  socket.on('msg', (d) => {
    const now = Date.now();
    const gap = socket.data.admin ? 500 : Math.max(500, slow * 1000);
    if (now - last < gap) { if (slow && !socket.data.admin && now - last >= 500) socket.emit('sys', 'Slow mode: please wait a moment.'); return; }
    const text = clean(d && d.text, 500);

    if (text === '/admin' || text.startsWith('/admin ')) {   // the password is never shown or stored
      last = now;
      const r = login(text.slice(6).trim());
      if (r === 'ok') { socket.data.admin = true; socket.emit('sys', 'Logged in as moderator. ' + ADMIN_HELP); }
      else socket.emit('sys', LOGIN_MSG[r]);
      return;
    }
    const [cmd, ...rest] = text.split(' ');
    if (socket.data.admin && ADMIN_CMDS.includes(cmd)) { last = now; return adminCommand(socket, cmd.slice(1), rest.join(' ').trim(), room); }

    if (offline) return;
    if (silenced && !socket.data.admin) return socket.emit('sys', 'Only moderators can send messages right now.');
    if (timeouts[key()] > now) return socket.emit('sys', 'You are timed out for ' + left(timeouts[key()]) + '.');
    if (!socket.data.admin) {
      recent = recent.filter(t => now - t < 10000); recent.push(now);
      if (recent.length > 6) { timeouts[key()] = now + 30000; return socket.emit('sys', 'Too fast. You are timed out for 30 seconds.'); }
      if (!links && LINK.test(text)) return socket.emit('sys', 'Links are not allowed in this chat.');
      if (text && text === lastText && now - lastTextAt < 30000) return socket.emit('sys', "Please don't repeat yourself.");
    }
    const img = d && typeof d.img === 'string' && imagesAllowed(room) && d.img.length < 1.4e6 && IMG.test(d.img) ? d.img : null;
    if (!text && !img) return;
    last = now; lastText = text; lastTextAt = now;
    const m = { id: socket.id, tok: key(), name: safeName(d && d.name), text: mask(text), t: now };
    if (img) m.img = img;
    store(room, m);
    io.to(room).emit('msg', pub(m));
    if (text[0] === '/') command(room, m.name, text);
  });

  socket.on('report', (d) => {
    const now = Date.now();
    if (blocked() || now - lastReact < 500 || !d) return;
    lastReact = now;
    const m = (rooms[room] || []).find(x => x.mid === d.mid);
    if (!m || m.bot || m.id === socket.id || m.rep.includes(key())) return;
    m.rep.push(key());
    socket.emit('sys', 'Thanks, your report was received.');
    if (m.rep.length === 1) adminSay('⚑ Report #' + m.mid + ' ' + m.name + ': "' + (m.text || '[image]').slice(0, 80) + '" | /delete ' + m.mid + ' or /timeout ' + m.mid + ' 10');
    if (m.rep.length >= REPORT_LIMIT) { removeMsg(m.mid); if (m.tok) strike(m.tok); console.log('[mod] message removed after reports'); }
  });

  socket.on('react', (d) => {
    const now = Date.now();
    if (blocked() || now - lastReact < 200 || !d || !EMOJIS.includes(d.e)) return;
    lastReact = now;
    const m = (rooms[room] || []).find(x => x.mid === d.mid);
    if (!m) return;
    const who = (m.v[d.e] ||= []);
    const i = who.indexOf(socket.id);
    if (i >= 0) who.splice(i, 1); else who.push(socket.id);
    if (who.length) m.r[d.e] = who.length; else { delete m.r[d.e]; delete m.v[d.e]; }
    io.to(room).emit('react', { mid: m.mid, r: m.r });
  });

  socket.on('typing', (n) => { if (!blocked()) socket.to(room).emit('typing', safeName(n)); });

  socket.on('game:open', () => {
    if (blocked()) return;
    const g = game(room);
    if (!g.p.X) g.p.X = socket.id; else if (!g.p.O && g.p.X !== socket.id) g.p.O = socket.id;
    pushGame(room);
  });
  socket.on('game:move', (i) => {
    if (blocked()) return;
    const g = game(room);
    const s = g.p.X === socket.id ? 'X' : g.p.O === socket.id ? 'O' : null;
    if (!s || g.w || g.turn !== s || !Number.isInteger(i) || i < 0 || i > 8 || g.b[i]) return;
    g.b[i] = s;
    if (LINES.some(l => l.every(k => g.b[k] === s))) g.w = s;
    else if (g.b.every(Boolean)) g.w = 'draw';
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
server.listen(PORT, () => console.log('Chat running on port ' + PORT + (offline ? ' (offline mode)' : '') + (ADMIN ? '' : ' | warning: ADMIN_PASSWORD is not set')));
