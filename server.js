const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const v8 = require('v8');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2e6 });
app.use(express.static('public'));

const MAX_MSGS = 50, MAX_IMGS = 8, TTL = 60 * 60 * 1000, REPORT_LIMIT = 3;
const ANNOUNCEMENT_TTL = 60 * 1000;
const rooms = {}, games = {}, timeouts = {}, strikes = {};   // everything lives in memory only; no IPs, no accounts
let latestAnnouncement = null, latestAnnouncementTimer = null;

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
// Render does not expose a documented built-in region variable; set SERVER_LOCATION in the Render dashboard.
const SERVER_LOCATION = String(process.env.SERVER_LOCATION || '').trim();
let offline = process.env.MAINTENANCE === '1';
let silenced = false, slow = 0, links = false, images = 'private';   // images: off | private | on
let banned = [], fails = [], maintTimers = [], midCount = 0;
const ADMIN_CMDS = ['/status', '/offline', '/online', '/wipe', '/clear', '/announce', '/maintenance', '/slow', '/restart', '/silence', '/block', '/unblock', '/log', '/reports', '/delete', '/timeout', '/pardon', '/links', '/images', '/dismiss', '/clearreports', '/notifytest', '/help', '/logout'];
const ADMIN_HELP = "Commands: /status /offline /online /wipe /clear /announce text /maintenance minutes /slow seconds /silence /block word /unblock word /reports /delete id /timeout id minutes /pardon /links on|off /images off|private|on /dismiss id /clearreports /notifytest /log /restart /logout";

// alerts: set any of these on Render (Environment). Outbound SMTP is blocked on free hosting, so e-mail goes through an HTTPS API.
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL || '';
const NTFY = process.env.NTFY_TOPIC || '', NTFY_URL = process.env.NTFY_URL || 'https://ntfy.sh';
const RESEND_KEY = process.env.RESEND_API_KEY || '', MAIL_TO = process.env.NOTIFY_EMAIL || '';
const RESEND_URL = process.env.RESEND_URL || 'https://api.resend.com/emails';
const MAIL_FROM = process.env.MAIL_FROM || 'Chat Moderation <onboarding@resend.dev>';
const channels = () => [WEBHOOK && 'discord', NTFY && 'ntfy', RESEND_KEY && MAIL_TO && 'email'].filter(Boolean);
let notifTimes = [];
function notify(title, body, urgent, force) {            // title must be plain ASCII (used in an HTTP header)
  const now = Date.now();
  notifTimes = notifTimes.filter(t => now - t < 3600000);
  if (!force && notifTimes.length >= 20) return console.log('[notify] hourly limit reached');
  notifTimes.push(now);
  const post = (url, opt) => fetch(url, { ...opt, signal: AbortSignal.timeout(8000) })
    .then(r => { if (!r.ok) console.log('[notify] failed: HTTP ' + r.status); })
    .catch(e => console.log('[notify] error: ' + e.message));
  const json = { 'Content-Type': 'application/json' };
  if (WEBHOOK) post(WEBHOOK, { method: 'POST', headers: json, body: JSON.stringify({ content: (urgent ? '🚨 ' : '⚑ ') + '**' + title + '**\n' + body.slice(0, 1500), allowed_mentions: { parse: [] } }) });
  if (NTFY) post(NTFY_URL + '/' + encodeURIComponent(NTFY), { method: 'POST', headers: { Title: title, Priority: urgent ? 'urgent' : 'high', Tags: urgent ? 'rotating_light' : 'warning' }, body });
  if (RESEND_KEY && MAIL_TO) post(RESEND_URL, { method: 'POST', headers: { ...json, Authorization: 'Bearer ' + RESEND_KEY }, body: JSON.stringify({ from: MAIL_FROM, to: [MAIL_TO], subject: title, text: body }) });
}
const REASONS = { spam: 'Spam or scam', harassment: 'Harassment or hate', sexual: 'Sexual content', threat: 'Threats or self-harm', illegal: 'Illegal content or child safety' };
const reportLog = new Map();   // kept 24h in memory, so you can review reports after the message is gone
const reportTimes = {};

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
function announce(t) {
  // Keep the latest global announcement in server memory so anyone joining
  // any room during its 60-second lifetime receives it as part of history.
  const message = {
    name: '📢',
    bot: true,
    admin: true,
    announcement: true,
    text: t,
    t: Date.now()
  };
  latestAnnouncement = message;
  if (latestAnnouncementTimer) clearTimeout(latestAnnouncementTimer);
  latestAnnouncementTimer = setTimeout(() => {
    if (latestAnnouncement === message) {
      latestAnnouncement = null;
      latestAnnouncementTimer = null;
    }
  }, ANNOUNCEMENT_TTL);

  // Socket.IO broadcasts to every connected socket, regardless of room.
  io.emit('msg', message);
  console.log('[admin] global announcement broadcast to all rooms');
}
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

// Sample CPU continuously so opening the admin panel never reports an average
// diluted by hours when no moderator was watching the dashboard.
let cpuUsageSample = process.cpuUsage();
let cpuUsageSampleAt = process.hrtime.bigint();
let recentCpuPct = 0;
let cpuSampleReady = false;

function sampleCpuUsage() {
  const now = process.hrtime.bigint();
  const elapsedMicros = Math.max(1, Number(now - cpuUsageSampleAt) / 1000);
  const delta = process.cpuUsage(cpuUsageSample);
  cpuUsageSample = process.cpuUsage();
  cpuUsageSampleAt = now;
  // 100% means the Node process has used one CPU core fully over the sample interval.
  recentCpuPct = Math.round(Math.max(0, (delta.user + delta.system) / elapsedMicros * 100));
  cpuSampleReady = true;
}
const cpuSampler = setInterval(sampleCpuUsage, 2000);
if (typeof cpuSampler.unref === 'function') cpuSampler.unref();

function getContainerMemoryLimit() {
  const files = ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes'];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(file, 'utf8').trim();
      if (!raw || raw === 'max') continue;
      const bytes = Number(raw);
      // cgroup v1 represents "unlimited" with a huge signed-64-bit value.
      if (Number.isFinite(bytes) && bytes > 0 && bytes < 8e18) return bytes;
    } catch (_) {}
  }
  if (typeof process.constrainedMemory === 'function') {
    try {
      const bytes = process.constrainedMemory();
      if (Number.isFinite(bytes) && bytes > 0 && bytes < 8e18) return bytes;
    } catch (_) {}
  }
  return null;
}

function getServerLoad() {
  const memory = process.memoryUsage();
  const heapLimit = v8.getHeapStatistics().heap_size_limit;
  const containerLimit = getContainerMemoryLimit();
  const rssPct = containerLimit ? Math.round(memory.rss / containerLimit * 100) : null;
  const heapPct = heapLimit > 0 ? Math.round(memory.heapUsed / heapLimit * 100) : 0;

  const critical = (cpuSampleReady && recentCpuPct >= 95) || heapPct >= 95 || (rssPct !== null && rssPct >= 95);
  const high = (cpuSampleReady && recentCpuPct >= 80) || heapPct >= 85 || (rssPct !== null && rssPct >= 85);
  return {
    cpuPct: recentCpuPct,
    cpuReady: cpuSampleReady,
    rssMB: Math.round(memory.rss / 1048576),
    rssPct,
    memoryLimitMB: containerLimit ? Math.round(containerLimit / 1048576) : null,
    heapUsedMB: Math.round(memory.heapUsed / 1048576),
    heapLimitMB: Math.round(heapLimit / 1048576),
    heapPct,
    level: !cpuSampleReady ? 'unknown' : critical ? 'critical' : high ? 'high' : 'normal'
  };
}

const statsLine = () =>
  'online: ' + io.engine.clientsCount + ' | rooms: ' + Object.keys(rooms).length +
  ' | messages: ' + Object.values(rooms).reduce((n, l) => n + l.length, 0) +
  ' | chat: ' + (offline ? 'OFFLINE' : 'online') + ' | images: ' + images + ' | links: ' + (links ? 'on' : 'blocked') +
  (slow ? ' | slow: ' + slow + 's' : '') + (silenced ? ' | SILENCED' : '') + (maintTimers.length ? ' | maintenance planned' : '') +
  ' | alerts: ' + (channels().join(',') || 'none') + ' | timeouts: ' + Object.values(timeouts).filter(t => t > Date.now()).length +
  ' | memory: ' + Math.round(process.memoryUsage().rss / 1048576) + ' MB';
const adminState = () => ({
  offline, silenced, slow, links, images, banned,
  online: io.engine.clientsCount, rooms: Object.keys(rooms).length,
  messages: Object.values(rooms).reduce((n, l) => n + l.length, 0),
  memory: Math.round(process.memoryUsage().rss / 1048576),
  load: getServerLoad(),
  serverLocation: SERVER_LOCATION || null,
  serverHost: process.env.RENDER_EXTERNAL_HOSTNAME || null,
  timeouts: Object.values(timeouts).filter(t => t > Date.now()).length,
  channels: channels(),
  reports: [...reportLog.values()].filter(e => e.status !== 'dismissed').slice(-15).reverse()
    .map(e => ({ mid: e.mid, name: e.name, text: e.text.slice(0, 150), n: e.reasons.length, reasons: [...new Set(e.reasons)].map(k => REASONS[k]), status: e.status, urgent: !!e.urgent }))
});
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
    const out = [...reportLog.values()].filter(e => e.status !== 'dismissed').slice(-8)
      .map(e => '#' + e.mid + ' [' + e.status + '] ' + e.name + ': "' + e.text.slice(0, 50) + '" (' + e.reasons.length + 'x ' + [...new Set(e.reasons)].join(',') + ')');
    say(out.join('\n') || 'No open reports.');
  }
  else if (c === 'delete') { const m = removeMsg(num); const e = reportLog.get(num); if (e) e.status = 'deleted'; say(m || e ? 'Message #' + num + ' deleted.' : 'Message not found.'); }
  else if (c === 'timeout') {
    const [id, min] = arg.split(' ').map(x => parseInt(x));
    const m = removeMsg(id), e = reportLog.get(id), tok = (m && m.tok) || (e && e.tok);
    if (!tok) return say('Usage: /timeout id minutes (message not found or has no author).');
    const mins = Math.min(Math.max(min || 10, 1), 1440);
    timeouts[tok] = Date.now() + mins * 60000;
    if (e) e.status = 'timed-out';
    console.log('[mod] timeout set by admin');
    say('Author of #' + id + ' timed out for ' + mins + ' min. Message removed.');
  }
  else if (c === 'dismiss') { const e = reportLog.get(num); if (!e) return say('Report not found.'); e.status = 'dismissed'; say('Report #' + num + ' dismissed.'); }
  else if (c === 'notifytest') {
    const ch = channels();
    if (!ch.length) return say('No alert channel set up. Add DISCORD_WEBHOOK_URL, NTFY_TOPIC or RESEND_API_KEY + NOTIFY_EMAIL on Render.');
    notify('Test notification', 'Alerts work. You will get a message like this when someone reports content.', false, true);
    say('Test sent via: ' + ch.join(', ') + '. Check your phone or inbox.');
  }
  else if (c === 'pardon') { for (const k in timeouts) delete timeouts[k]; for (const k in strikes) delete strikes[k]; say('All timeouts and strikes cleared.'); }
  else if (c === 'log') say(events.slice(-12).join('\n') || 'Nothing logged yet.');
  else if (c === 'restart') { say('Restarting. Render starts the server again automatically (about a minute).'); console.log('[admin] restart requested'); setTimeout(() => process.exit(0), 500); }
  else if (c === 'clearreports') { const n = reportLog.size; reportLog.clear(); for (const r in rooms) for (const m of rooms[r]) if (m.rep) m.rep = []; say(n + ' report(s) cleared.'); }
  else if (c === 'logout') { socket.data.admin = false; socket.emit('admin', false); say('Logged out as moderator.'); }
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
  for (const [k, e] of reportLog) if (now - e.t > 86400000) reportLog.delete(k);
  for (const k in reportTimes) if (!reportTimes[k].some(t => now - t < 600000)) delete reportTimes[k];
}, 60 * 1000);
setInterval(() => { for (const k in strikes) delete strikes[k]; }, 60 * 60 * 1000);
setInterval(() => console.log('[stats] ' + statsLine()), 10 * 60 * 1000);

io.on('connection', (socket) => {
  console.log('[online] ' + io.engine.clientsCount);
  let room = 'general', last = 0, lastReact = 0, lastReport = 0, lastText = '', lastTextAt = 0, recent = [];
  const blocked = () => offline && !socket.data.admin;
  const key = () => socket.data.tok || socket.id;

  socket.on('join', (d) => {
    room = roomName(d && d.room);
    socket.data.tok = clean(d && d.tok, 32);
    socket.join(room);
    socket.emit('config', { images: imagesAllowed(room) });
    if (blocked()) return socket.emit('closed', true);
    const now = Date.now();
    const history = (rooms[room] || []).filter(m => now - m.t < TTL).map(pub);
    // Announcements are global, not tied to a room's message list. Include
    // the latest one for new joiners while its one-minute banner is active.
    if (latestAnnouncement && now - latestAnnouncement.t < ANNOUNCEMENT_TTL) {
      history.push(latestAnnouncement);
    }
    socket.emit('history', history);
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
      if (r === 'ok') { socket.data.admin = true; socket.emit('admin', true); socket.emit('sys', 'Logged in as moderator. Tap ⚙ Admin in the header (or type /help).'); }
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
    const isAdmin = socket.data.admin === true;
    const m = { id: socket.id, tok: key(), name: isAdmin ? 'Admin' : safeName(d && d.name), admin: isAdmin, text: mask(text), t: now };
    if (img) m.img = img;
    store(room, m);
    io.to(room).emit('msg', pub(m));
    if (text[0] === '/') command(room, m.name, text);
  });

  socket.on('report', (d) => {
    const now = Date.now();
    if (blocked() || !d || now - lastReport < 1000 || !REASONS[d.reason]) return;
    lastReport = now;
    const k = key();
    reportTimes[k] = (reportTimes[k] || []).filter(t => now - t < 600000);
    if (reportTimes[k].length >= 5) return socket.emit('sys', 'You sent too many reports. Please wait a few minutes.');
    const m = (rooms[room] || []).find(x => x.mid === d.mid);
    if (!m || m.bot || m.id === socket.id || m.rep.includes(k)) return;
    reportTimes[k].push(now);
    m.rep.push(k);
    let e = reportLog.get(m.mid);
    if (!e) { e = { mid: m.mid, name: m.name, text: m.text || '[image]', tok: m.tok, reasons: [], t: now, status: 'open' }; reportLog.set(m.mid, e); }
    e.reasons.push(d.reason);
    const urgent = d.reason === 'illegal' || d.reason === 'threat';
    const remove = d.reason === 'illegal' || m.rep.length >= REPORT_LIMIT;
    const notifyNow = m.rep.length === 1 || remove || (urgent && !e.urgent);
    if (urgent) e.urgent = true;
    socket.emit('sys', 'Thank you. Your report was sent to the moderators.');
    if (remove) { removeMsg(m.mid); e.status = 'removed'; if (m.tok) strike(m.tok); console.log('[mod] message removed after report'); }
    if (notifyNow) {
      const body = 'Report #' + m.mid + ' (' + e.reasons.length + ' so far): ' + REASONS[d.reason] + '\nAuthor: ' + m.name + '\nMessage: "' + (m.text || '[image]').slice(0, 300) + '"\nStatus: ' + (remove ? 'removed' : 'still visible, waiting for your review') +
        '\nTo act: open the chat, type /admin followed by your password, then /delete ' + m.mid + ' or /timeout ' + m.mid + ' 60 or /dismiss ' + m.mid;
      adminSay('⚑ ' + body.split('\nTo act')[0].replace(/\n/g, ' | '));
      notify(urgent ? 'URGENT chat report' : 'Chat report', body, urgent);
    }
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

  socket.on('health:ping', (d) => {
    // Only authenticated moderators can use the dashboard's latency probe.
    if (!socket.data.admin || !d || !Number.isSafeInteger(d.id)) return;
    socket.emit('health:pong', { id: d.id, serverTime: Date.now() });
  });

  socket.on('adm', (text) => {      // admin panel: same commands as typing them, plus a state update
    if (!socket.data.admin) return;
    const [cmd, ...rest] = clean(text, 400).split(' ');
    if (ADMIN_CMDS.includes(cmd)) adminCommand(socket, cmd.slice(1), rest.join(' ').trim(), room);
    if (socket.data.admin) socket.emit('adm:state', adminState());
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
