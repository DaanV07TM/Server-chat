const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const dns = require('dns').promises;
const net = require('net');
const os = require('os');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const v8 = require('v8');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 14 * 1024 * 1024 });
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Voice and screen capture are allowed only for this page; the camera is not used.
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), display-capture=(self), geolocation=()');
  next();
});

// Lightweight endpoint for external uptime checks and scheduled keep-alive probes.
app.get('/healthz', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(200).json({ ok: true });
});

// Optional managed TURN credentials. Keep the provider API key in Render, never in browser code.
// Set TURN_CREDENTIALS_URL to the Metered endpoint shown in its dashboard.
const TURN_CREDENTIALS_URL = String(process.env.TURN_CREDENTIALS_URL || '').trim();
let turnCredentialsCache = { iceServers: null, expiresAt: 0, lastAttemptAt: 0 };
app.get('/api/turn-credentials', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!TURN_CREDENTIALS_URL) return res.status(503).json({ iceServers: [] });
  const now = Date.now();
  if (turnCredentialsCache.iceServers && turnCredentialsCache.expiresAt > now) {
    return res.json({ iceServers: turnCredentialsCache.iceServers });
  }
  // Avoid repeated upstream requests if the provider is unavailable or a client refreshes repeatedly.
  if (turnCredentialsCache.lastAttemptAt && now - turnCredentialsCache.lastAttemptAt < 10000) {
    return res.status(503).json({ iceServers: [] });
  }
  turnCredentialsCache.lastAttemptAt = now;
  try {
    const endpoint = new URL(TURN_CREDENTIALS_URL);
    if (endpoint.protocol !== 'https:' ||
        !endpoint.hostname.endsWith('.metered.live') ||
        endpoint.pathname !== '/api/v1/turn/credentials') {
      return res.status(500).json({ iceServers: [] });
    }
    const upstream = await fetch(endpoint, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(6000)
    });
    if (!upstream.ok) return res.status(502).json({ iceServers: [] });
    const result = await upstream.json();
    if (!Array.isArray(result)) return res.status(502).json({ iceServers: [] });
    const iceServers = result.map(item => {
      if (!item || typeof item !== 'object') return null;
      const rawUrls = Array.isArray(item.urls) ? item.urls : [item.urls];
      const urls = rawUrls.filter(value => typeof value === 'string' && /^(stun|turn|turns):/i.test(value));
      if (!urls.length) return null;
      const entry = { urls };
      if (typeof item.username === 'string') entry.username = item.username;
      if (typeof item.credential === 'string') entry.credential = item.credential;
      return entry;
    }).filter(Boolean);
    if (!iceServers.length) return res.status(502).json({ iceServers: [] });
    turnCredentialsCache = {
      iceServers,
      expiresAt: now + 5 * 60 * 1000,
      lastAttemptAt: now
    };
    return res.json({ iceServers });
  } catch (error) {
    console.warn('[voice] TURN credential lookup failed:', error && error.message ? error.message : 'unknown error');
    return res.status(502).json({ iceServers: [] });
  }
});

app.use(express.static('public'));

const MAX_MSGS = 50, MAX_IMGS = 8, TTL = 60 * 60 * 1000, REPORT_LIMIT = 3;
const MAX_ANNOUNCEMENT_HISTORY = 1000;
const ANNOUNCEMENT_TTL = 60 * 1000;
const ADMIN_IMAGE_LIST_LIMIT = 6;
const USER_BAN_MS = 24 * 60 * 60 * 1000;
const userBans = new Map();
const OFFICIAL_ANNOUNCEMENT_INFO = [
  { name: 'Server guide', bot: true, pinned: true, text: 'Welcome to #announcements. This is the official read-only channel: only moderators can publish updates. These pinned guide posts are built into the app and return after a server restart.' },
  { name: 'Channel guide', bot: true, pinned: true, text: 'Choose #general for casual chat, #help for questions, #announcements for official updates, #voice for optional voice chat and screen sharing, and #music for shared music search and playback relayed by the server. Text in public and official channels is not end-to-end encrypted; only private-* room text is encrypted. Images are not end-to-end encrypted and appear in chat immediately while moderators can review them. In #voice, click Join voice before your microphone is enabled; mute or leave whenever you like. In #music, search the catalogue or upload audio you have permission to share, then use the shared playback controls.' },
  { name: 'Privacy & retention', bot: true, pinned: true, text: 'Text in private-* rooms is end-to-end encrypted in the browser using the private invite-link key; public and official channel text is not end-to-end encrypted and can be read by the server. Share a private-room invite with its intended participants only. Images are not end-to-end encrypted: they appear immediately in chat and are also sent to the moderator review panel across public and private rooms. Moderators can mark images reviewed, delete posts, or ban uploaders. Review is manual, not automated detection, and cannot prevent an image from being seen before a moderator acts. This implementation has not been independently audited, and a compromised server could serve modified browser code. Ordinary room history is held in server memory for up to one hour. Hosting providers may process connection metadata.' },
  { name: 'Safety reminder', bot: true, pinned: true, text: 'Do not share passwords, private addresses, personal documents, or other sensitive information. Screen shares can be seen by people in the room and may be monitored or stopped by moderators. Images appear in chat immediately and moderators can review them, but manual review cannot prevent harmful or illegal images from being seen before a moderator acts. Use the report flag ⚑ for abusive messages, scams, threats, or other rule violations.' }
];
const MAX_VOICE_USERS = 8; // Mesh WebRTC voice is intended for small groups.
const rooms = {}, timeouts = {}, strikes = {};   // everything lives in memory only; no IPs, no accounts
let latestAnnouncement = null, latestAnnouncementTimer = null;
const screenSharers = Object.create(null); // one active WebRTC screen sharer per room
const screenViewerRooms = new Map(); // viewer socket ID -> room they are authorized to view
const voiceParticipants = new Map(); // 'voice' -> Map(socket ID -> { name, joinedAt })
const MUSIC_MAX_TRACKS = 20;
const MUSIC_MAX_PER_USER = 5;
const MUSIC_MAX_FILE_BYTES = 8 * 1024 * 1024;
const MUSIC_MAX_STORED_BYTES = 24 * 1024 * 1024;
const MUSIC_TYPES = Object.freeze({
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.flac': 'audio/flac'
});
const AUDIUS_API_BASE_URL = String(process.env.AUDIUS_API_BASE_URL || 'https://api.audius.co/v1').trim().replace(/\/+$/, '');
const AUDIUS_API_KEY = String(process.env.AUDIUS_API_KEY || '').trim();
const AUDIUS_APP_NAME = String(process.env.AUDIUS_APP_NAME || 'ServerChat').trim().replace(/[^A-Za-z0-9_-]/g, '') || 'ServerChat';
const MUSIC_ADDON_TIMEOUT_MS = 12000;
const MUSIC_CACHE_DOWNLOAD_TIMEOUT_MS = 180000;
const MUSIC_MAX_RELAY_CACHE_BYTES = 120 * 1024 * 1024;
const MUSIC_RELAY_CACHE_DIR = path.join(os.tmpdir(), 'server-chat-music-relay-cache');
try { fs.rmSync(MUSIC_RELAY_CACHE_DIR, { recursive: true, force: true }); } catch (_) {}
fs.mkdirSync(MUSIC_RELAY_CACHE_DIR, { recursive: true });
const MUSIC_SEARCH_CACHE_TTL = 30 * 1000;
const MUSIC_CATALOG_TTL = 10 * 60 * 1000;
const MUSIC_CATALOG_LIMIT = 500;
const MUSIC_STREAM_CHECK_TTL = 15 * 1000;
const musicSearchCache = new Map();
const musicCatalogCache = new Map();
const musicStreamCheckCache = new Map();
const musicHostCooldowns = new Map();
const musicQueue = [];
let musicCurrent = null, musicTrackId = 0, musicLastSkipAt = 0, musicStoredBytes = 0;
let musicPlayback = { isPlaying: false, position: 0, startedAt: null, changedBy: null };
let musicPausedByAdmin = false;

// Bounded in-memory server log for the moderator dashboard and /log command.
// Keep entries short and redact common secret-shaped values before they reach the UI.
const events = [];
const MAX_SERVER_LOGS = 100;
function captureConsole(original, level) {
  return (...args) => {
    original.apply(console, args);
    const raw = args.map(value => typeof value === 'string' ? value : String(value)).join(' ');
    if (raw.startsWith('[online]')) return;
    const safe = raw
      .replace(/(password|passwd|token|secret|api[_ -]?key|authorization|webhook)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[redacted]')
      .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[redacted]')
      .slice(0, 500);
    events.push(new Date().toISOString() + ' [' + level + '] ' + safe);
    if (events.length > MAX_SERVER_LOGS) events.shift();
  };
}
console.log = captureConsole(console.log, 'INFO');
console.warn = captureConsole(console.warn, 'WARN');
console.error = captureConsole(console.error, 'ERROR');

// Admin session tokens are held only in memory. They automatically expire when this process restarts.
const ADMIN = process.env.ADMIN_PASSWORD || '';
const adminSessions = new Map();
const MAX_ADMIN_SESSIONS = 100;
function issueAdminSession() {
  // Drop and revoke the oldest session if the in-memory session set reaches its safety limit.
  if (adminSessions.size >= MAX_ADMIN_SESSIONS) {
    const oldestToken = adminSessions.keys().next().value;
    adminSessions.delete(oldestToken);
    for (const client of io.sockets.sockets.values()) {
      if (client.data.adminToken === oldestToken) {
        client.data.admin = false;
        client.data.adminToken = null;
        client.emit('admin:session-revoked');
        client.emit('admin', false);
      }
    }
  }
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.set(token, Date.now());
  return token;
}
// Controlled restart is requested by exiting after a global countdown. Render may
// recover a failed instance, but this is best-effort without the authenticated API.
let restartInProgress = false, restartSubmitted = false;
let restartTimer = null, restartCountdownTimers = [];
// Render does not expose a documented built-in region variable; set SERVER_LOCATION in the Render dashboard.
const SERVER_LOCATION = String(process.env.SERVER_LOCATION || '').trim();
let offline = process.env.MAINTENANCE === '1';
let silenced = false, slow = 0, links = false, images = 'on';   // images: off | private | on
let banned = [], fails = [], maintTimers = [], midCount = 0;
const ADMIN_CMDS = ['/status', '/offline', '/online', '/wipe', '/clear', '/announce', '/maintenance', '/slow', '/restart', '/cancelrestart', '/silence', '/block', '/unblock', '/log', '/reports', '/delete', '/timeout', '/pardon', '/links', '/images', '/dismiss', '/clearreports', '/notifytest', '/help', '/logout'];
const ADMIN_HELP = "Commands: /status /offline /online /wipe /clear /announce text /maintenance minutes /slow seconds /silence /block word /unblock word /reports /delete id /timeout id minutes /pardon /links on|off /images off|private|on /dismiss id /clearreports /notifytest /log /restart /cancelrestart /logout";

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
const USER_STATUSES = ['Online', 'Gaming', 'Away', 'Do not disturb'];
const pub = (m) => { const { v, rep, tok, ...rest } = m; return rest; };
// Personalize message payloads without ever exposing the browser identity token.
function emitPersonalizedRoomMessage(roomName, eventName, message) {
  const members = io.sockets.adapter.rooms.get(roomName);
  if (!members) return;
  const safeMessage = pub(message);
  for (const socketId of members) {
    const recipient = io.sockets.sockets.get(socketId);
    if (!recipient) continue;
    const recipientToken = recipient.data.tok || recipient.id;
    recipient.emit(eventName, { ...safeMessage, own: !!message.tok && message.tok === recipientToken });
  }
}

function store(room, m) {
  if (!m.mid) { m.mid = ++midCount; m.v = {}; m.r = {}; m.rep = []; }
  if (!rooms[room]) console.log('[room] new room active');
  const list = (rooms[room] ||= []);
  list.push(m);
  const roomLimit = room === 'announcements' ? MAX_ANNOUNCEMENT_HISTORY : MAX_MSGS;
  if (list.length > roomLimit) list.shift();
  const withImg = list.filter(x => x.img);
  while (withImg.length > MAX_IMGS) { const o = withImg.shift(); delete o.img; delete o.imageApproved; o.text = o.text || '(image removed)'; }
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
  // Keep a durable copy in the official channel while retaining the brief global banner.
  const archived = { ...message, announcement: false, persistentAnnouncement: true };
  store('announcements', archived);
  io.to('announcements').emit('msg', pub(archived));

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
function findStoredMessage(mid) {
  for (const roomName of Object.keys(rooms)) {
    const message = rooms[roomName].find(item => item.mid === mid);
    if (message) return { room: roomName, message };
  }
  return null;
}
function activeUserBan(token) {
  const ban = userBans.get(token);
  if (!ban) return null;
  if (ban.expiresAt && ban.expiresAt <= Date.now()) { userBans.delete(token); return null; }
  return ban;
}
function getAdminImageList() {
  const images = [];
  for (const roomName of Object.keys(rooms)) {
    for (const message of rooms[roomName]) {
      if (!message.img) continue;
      images.push({ mid: message.mid, room: roomName, name: message.name, t: message.t, img: message.img, admin: !!message.admin, pending: message.imageApproved === false, reviewed: message.imageReviewed === true });
    }
  }
  return images.sort((a, b) => b.t - a.t).slice(0, ADMIN_IMAGE_LIST_LIMIT);
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
  events: events.slice(-80),
  restartInProgress, restartSubmitted,
  online: io.engine.clientsCount, rooms: Object.keys(rooms).length,
  messages: Object.values(rooms).reduce((n, l) => n + l.length, 0),
  memory: Math.round(process.memoryUsage().rss / 1048576),
  load: getServerLoad(),
  serverLocation: SERVER_LOCATION || null,
  serverHost: process.env.RENDER_EXTERNAL_HOSTNAME || null,
  timeouts: Object.values(timeouts).filter(t => t > Date.now()).length,
  channels: channels(),
  screenShares: Object.entries(screenSharers).map(([room, share]) => ({ room, name: share.name, sharerId: share.socketId, startedAt: share.startedAt, durationSeconds: Math.max(0, Math.floor((Date.now() - share.startedAt) / 1000)), viewers: share.viewers ? share.viewers.size : 0 })),
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
  else if (c === 'restart') {
    if (restartInProgress) return say(restartSubmitted
      ? 'The server is already shutting down for restart.'
      : 'A restart countdown is already running. Use /cancelrestart to cancel it.');
    restartInProgress = true;
    restartSubmitted = false;
    announce('☢️ SERVER RESTART SEQUENCE INITIATED — The chat will restart in 15 seconds. Please finish your messages.');
    say('Restart sequence started. Everyone has been notified. Use /cancelrestart within the countdown to abort.');
    console.log('[admin] controlled server restart countdown started');

    const countdown = [
      [5000, '10 seconds'],
      [10000, '5 seconds'],
      [12000, '3 seconds'],
      [13000, '2 seconds'],
      [14000, '1 second']
    ];
    restartCountdownTimers = countdown.map(([delay, remaining]) => setTimeout(() => {
      if (restartInProgress && !restartSubmitted) {
        announce('☢️ SERVER RESTART IN ' + remaining.toUpperCase() + ' — reconnect shortly.');
      }
    }, delay));

    restartTimer = setTimeout(() => {
      restartTimer = null;
      restartCountdownTimers = [];
      if (!restartInProgress || restartSubmitted) return;
      restartSubmitted = true;
      announce('☢️ SERVER RESTARTING NOW — Your connection will drop briefly. The chat should reconnect when the service is available.');
      io.emit('server:restarting', { message: 'The server is restarting. Your chat should reconnect in a moment.' });
      console.log('[admin] restart requested; closing Socket.IO and HTTP server');

      // Stop accepting new connections and close live voice/screen/chat sockets.
      // A non-zero exit marks the process as failed so Render can recover it.
      const forceExit = setTimeout(() => process.exit(1), 8000);
      io.close(() => {
        clearTimeout(forceExit);
        console.log('[admin] server closed for restart');
        process.exit(1);
      });
    }, 15000);
  }
  else if (c === 'cancelrestart') {
    if (!restartInProgress || restartSubmitted) {
      return say(restartSubmitted
        ? 'The server shutdown has already started and can no longer be cancelled here.'
        : 'There is no active restart countdown.');
    }
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    restartCountdownTimers.forEach(clearTimeout);
    restartCountdownTimers = [];
    restartInProgress = false;
    restartSubmitted = false;
    announce('✅ SERVER RESTART CANCELLED BY A MODERATOR — The chat will remain online.');
    adminSay('Restart countdown cancelled. The chat will remain online.');
    console.log('[admin] restart countdown cancelled');
  }
    else if (c === 'clearreports') { const n = reportLog.size; reportLog.clear(); for (const r in rooms) for (const m of rooms[r]) if (m.rep) m.rep = []; say(n + ' report(s) cleared.'); }
  else if (c === 'logout') {
    const token = socket.data.adminToken;
    if (token) adminSessions.delete(token);
    for (const client of io.sockets.sockets.values()) {
      if (client.id === socket.id || (token && client.data.adminToken === token)) {
        removeScreenViewer(client.id);
        client.data.admin = false;
        client.data.adminToken = null;
        client.emit('admin:session-revoked');
        client.emit('admin', false);
      }
    }
    say('Logged out as moderator.');
  }
  else say(ADMIN_HELP);
}

setInterval(() => {
  const now = Date.now();
  for (const r in rooms) {
    // Moderator posts in #announcements are retained for the lifetime of this
    // process; regular room history still expires after one hour.
    if (r !== 'announcements') rooms[r] = rooms[r].filter(m => now - m.t < TTL);
    if (!rooms[r].length) delete rooms[r];
  }
  for (const k in timeouts) if (timeouts[k] < now) delete timeouts[k];
  for (const [k, e] of reportLog) if (now - e.t > 86400000) reportLog.delete(k);
  for (const k in reportTimes) if (!reportTimes[k].some(t => now - t < 600000)) delete reportTimes[k];
}, 60 * 1000);
setInterval(() => { for (const k in strikes) delete strikes[k]; }, 60 * 60 * 1000);
setInterval(() => console.log('[stats] ' + statsLine()), 10 * 60 * 1000);


function addScreenViewer(socketId, screenRoom) {
  let viewingRooms = screenViewerRooms.get(socketId);
  if (!viewingRooms) {
    viewingRooms = new Set();
    screenViewerRooms.set(socketId, viewingRooms);
  }
  viewingRooms.add(screenRoom);
}

function removeScreenViewer(socketId, screenRoom) {
  if (screenRoom) {
    const share = screenSharers[screenRoom];
    if (share && share.viewers) share.viewers.delete(socketId);
    const viewingRooms = screenViewerRooms.get(socketId);
    if (viewingRooms) {
      viewingRooms.delete(screenRoom);
      if (!viewingRooms.size) screenViewerRooms.delete(socketId);
    }
    return;
  }
  for (const share of Object.values(screenSharers)) {
    if (share.viewers) share.viewers.delete(socketId);
  }
  screenViewerRooms.delete(socketId);
}

function endScreenShare(socketId) {
  removeScreenViewer(socketId);
  for (const [screenRoom, share] of Object.entries(screenSharers)) {
    if (share.socketId !== socketId) continue;
    delete screenSharers[screenRoom];
    for (const viewerId of (share.viewers || [])) {
      share.viewers.delete(viewerId);
      removeScreenViewer(viewerId, screenRoom);
      io.to(viewerId).emit('screen:stopped', { sharerId: socketId, room: screenRoom });
    }
    io.to(screenRoom).emit('screen:stopped', { sharerId: socketId, room: screenRoom });
    console.log('[screen] sharing stopped in room ' + screenRoom);
  }
}

function getVoiceRoster() {
  const roster = voiceParticipants.get('voice');
  return roster ? [...roster.entries()].map(([id, participant]) => ({ id, name: participant.name })) : [];
}

function broadcastVoiceState() {
  io.to('voice').emit('voice:state', { participants: getVoiceRoster() });
}

function parseYouTubeVideoId(raw) {
  try {
    const url = new URL(String(raw || ''));
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    let videoId = '';
    if (host === 'youtu.be') {
      videoId = url.pathname.split('/').filter(Boolean)[0] || '';
    } else if (['youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
      videoId = url.searchParams.get('v') || '';
      if (!videoId) {
        const match = url.pathname.match(/^\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{11})(?:\/|$)/);
        if (match) videoId = match[1];
      }
    } else {
      return null;
    }
    return /^[A-Za-z0-9_-]{11}$/.test(videoId) ? videoId : null;
  } catch (_) {
    return null;
  }
}

const publicMusicTrack = track => track && ({
  id: track.id,
  title: track.title,
  artist: track.artist || undefined,
  album: track.album || undefined,
  duration: Number.isFinite(Number(track.duration)) && Number(track.duration) > 0 ? Number(track.duration) : undefined,
  addedBy: track.addedBy,
  addedAt: track.addedAt,
  source: track.source || 'upload',
  prepared: track.source !== 'addon' || !!track.relayCachePath,
  format: track.format || (track.extension ? track.extension.slice(1).toUpperCase() : 'AUDIO'),
  sizeBytes: track.audio ? track.audio.length : 0
});
function getMusicPosition(now = Date.now()) {
  if (!musicPlayback.isPlaying || !Number.isFinite(musicPlayback.startedAt)) {
    return Math.max(0, Number(musicPlayback.position) || 0);
  }
  return Math.max(0, (Number(musicPlayback.position) || 0) + Math.max(0, now - musicPlayback.startedAt) / 1000);
}
function getMusicPlayback(now = Date.now()) {
  return {
    isPlaying: musicPlayback.isPlaying,
    position: Number(getMusicPosition(now).toFixed(3)),
    serverTime: now,
    changedBy: musicPlayback.changedBy
  };
}
const getMusicState = () => ({
  current: publicMusicTrack(musicCurrent),
  queue: musicQueue.map(publicMusicTrack),
  maxTracks: MUSIC_MAX_TRACKS,
  maxUploadBytes: MUSIC_MAX_FILE_BYTES,
  maxStoredBytes: MUSIC_MAX_STORED_BYTES,
  playback: getMusicPlayback()
});
const broadcastMusicState = () => io.to('music').emit('music:state', getMusicState());

function findMusicTrack(id) {
  if (musicCurrent && musicCurrent.id === id) return musicCurrent;
  return musicQueue.find(track => track.id === id) || null;
}
function releaseMusicTrack(track) {
  if (!track) return;
  if (Buffer.isBuffer(track.audio)) {
    musicStoredBytes = Math.max(0, musicStoredBytes - track.audio.length);
    track.audio = null;
  }
  const cachedPath = track.relayCachePath || track.relayCacheTempPath;
  track.relayCachePath = null;
  track.relayCacheTempPath = null;
  if (cachedPath) fs.promises.unlink(cachedPath).catch(() => {});
}

function musicCurrentHasFinished(now = Date.now()) {
  if (!musicCurrent || musicPlayback.isPlaying || musicPausedByAdmin) return false;
  const duration = Number(musicCurrent.duration);
  return Number.isFinite(duration) && duration > 0 && getMusicPosition(now) >= duration - 0.05;
}

function queueMusicTrack(track, now = Date.now()) {
  if (!musicCurrent || musicCurrentHasFinished(now)) {
    if (musicCurrent) releaseMusicTrack(musicCurrent);
    musicCurrent = track;
    const isCatalogueTrack = track.source === 'addon';
    musicPlayback = {
      isPlaying: !isCatalogueTrack,
      position: 0,
      startedAt: isCatalogueTrack ? null : now,
      changedBy: null
    };
    if (isCatalogueTrack) prepareCurrentMusicTrack(track);
    return true;
  }
  musicQueue.push(track);
  return false;
}

function advanceMusicTrack(now = Date.now(), reason = 'ended') {
  if (!musicCurrent) return;
  const previous = musicCurrent;
  if (reason === 'admin skip') musicLastSkipAt = now;
  if (musicQueue.length) {
    musicCurrent = musicQueue.shift();
    releaseMusicTrack(previous);
    const nextIsReady = musicCurrent.source !== 'addon' || !!musicCurrent.relayCachePath;
    const shouldStartNow = nextIsReady && !musicPausedByAdmin;
    musicPlayback = {
      isPlaying: shouldStartNow,
      position: 0,
      startedAt: shouldStartNow ? now : null,
      changedBy: null
    };
    console.log('[music] ' + reason + '; advancing shared queue' + (shouldStartNow ? '' : ' and preparing the next track'));
    if (musicCurrent.source === 'addon' && !musicCurrent.relayCachePath) prepareCurrentMusicTrack(musicCurrent);
  } else {
    const duration = Number(previous.duration);
    const finalPosition = Number.isFinite(duration) && duration > 0 ? duration : getMusicPosition(now);
    musicPlayback = { isPlaying: false, position: finalPosition, startedAt: null, changedBy: null };
    console.log('[music] ' + reason + '; shared track ended and playback stopped');
  }
  broadcastMusicState();
}

// Keep the playlist moving from the authoritative server clock, even when no
// browser is connected to #music to report an audio "ended" event.
function maintainMusicPlayback(now = Date.now()) {
  const current = musicCurrent;
  if (!current || musicPausedByAdmin) return;
  const duration = Number(current.duration);
  if (!Number.isFinite(duration) || duration <= 0) return;
  if (getMusicPosition(now) < duration - 0.35) return;

  if (musicQueue.length) {
    advanceMusicTrack(now, 'server playback clock reached track end');
    return;
  }

  if (musicPlayback.isPlaying) {
    musicPlayback = { isPlaying: false, position: duration, startedAt: null, changedBy: null };
    console.log('[music] server playback clock reached track end; waiting for the next queued track');
    broadcastMusicState();
  }
}

const musicPlaybackTicker = setInterval(() => {
  try { maintainMusicPlayback(Date.now()); }
  catch (error) { console.log('[music] playback ticker error: ' + safeMusicDiagnosticMessage(error)); }
}, 1000);
if (typeof musicPlaybackTicker.unref === 'function') musicPlaybackTicker.unref();

// All catalogue requests originate on this server. Do not forward visitor headers or IPs.
function musicAddonEndpoint(path) {
  const base = new URL(AUDIUS_API_BASE_URL);
  if (base.protocol !== 'https:' || base.username || base.password) {
    throw new Error('Music addon must be configured as a public HTTPS URL.');
  }
  const basePath = base.pathname.endsWith('/') ? base.pathname : base.pathname + '/';
  return new URL(String(path).replace(/^\/+/, ''), base.origin + basePath);
}

function publicMusicAddress(address) {
  const version = net.isIP(address);
  if (version === 4) {
    const [a, b, c] = address.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
    if (a === 192 && b === 88 && c === 99) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (version === 6) {
    const value = address.toLowerCase().split('%')[0];
    if (value === '::' || value === '::1' || value.startsWith('::ffff:')) return false;
    if (/^(fc|fd|fe[89ab]|ff)/i.test(value) || value.startsWith('2001:db8:')) return false;
    const first = parseInt(value.split(':')[0] || '0', 16);
    return first >= 0x2000 && first <= 0x3fff;
  }
  return false;
}

async function validatePublicAudioUrl(value) {
  let url;
  try { url = new URL(value); } catch (_) { throw new Error('The music provider returned an invalid stream URL.'); }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password ||
      !hostname || hostname === 'localhost' || hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error('The music provider returned a blocked stream URL.');
  }
  if (url.port && url.port !== '443') throw new Error('The music provider returned an unsupported stream port.');
  if (net.isIP(hostname)) {
    if (!publicMusicAddress(hostname)) throw new Error('The music provider returned a non-public stream address.');
  } else {
    const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(item => !publicMusicAddress(item.address))) {
      throw new Error('The music provider returned a non-public stream destination.');
    }
  }
  return url;
}

async function requestMusicAddonJson(url) {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(MUSIC_ADDON_TIMEOUT_MS),
    redirect: 'follow'
  });
  if (!response.ok) {
    const error = new Error('Audius API returned HTTP ' + response.status);
    error.statusCode = response.status;
    throw error;
  }
  return response.json();
}

function pruneMusicCaches() {
  const now = Date.now();
  for (const [key, entry] of musicSearchCache) if (entry.expiresAt <= now) musicSearchCache.delete(key);
  for (const [key, entry] of musicCatalogCache) if (entry.expiresAt <= now) musicCatalogCache.delete(key);
  for (const [key, expiresAt] of musicHostCooldowns) if (expiresAt <= now) musicHostCooldowns.delete(key);
  while (musicSearchCache.size > 100) musicSearchCache.delete(musicSearchCache.keys().next().value);
  while (musicCatalogCache.size > MUSIC_CATALOG_LIMIT) musicCatalogCache.delete(musicCatalogCache.keys().next().value);
}

app.get('/api/music/search', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const query = clean(typeof req.query.q === 'string' ? req.query.q : '', 100);
  if (query.length < 2) return res.status(400).json({ error: 'Enter at least two characters to search.' });
  pruneMusicCaches();
  const cacheKey = query.toLocaleLowerCase();
  let cached = musicSearchCache.get(cacheKey);
  if (!cached || cached.expiresAt <= Date.now()) {
    try {
      const url = musicAddonEndpoint('tracks/search');
      url.searchParams.set('query', query);
      url.searchParams.set('limit', '20');
      url.searchParams.set('sort_method', 'relevant');
      if (AUDIUS_API_KEY) url.searchParams.set('api_key', AUDIUS_API_KEY);
      else url.searchParams.set('app_name', AUDIUS_APP_NAME);

      const body = await requestMusicAddonJson(url);
      const rawTracks = body && Array.isArray(body.data) ? body.data : [];
      const tracks = [];
      for (const raw of rawTracks.slice(0, 20)) {
        if (!raw || typeof raw !== 'object') continue;
        const sourceId = (typeof raw.id === 'string' || typeof raw.id === 'number') ? String(raw.id) : '';
        const title = clean(raw.title, 120);
        const duration = Number(raw.duration);
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(sourceId) || !title ||
            !Number.isFinite(duration) || duration <= 0 || duration > 86400 ||
            raw.is_available === false || raw.is_streamable === false ||
            raw.is_stream_gated === true || raw.is_unlisted === true) continue;

        const user = raw.user && typeof raw.user === 'object' ? raw.user : {};
        const album = raw.album && typeof raw.album === 'object' ? raw.album : {};
        const catalogId = crypto.randomBytes(16).toString('hex');
        const track = {
          sourceId,
          title,
          artist: clean(user.name || user.handle || raw.artist, 120),
          album: clean(album.title || raw.album_name || raw.playlist_name, 120),
          duration,
          format: 'MP3',
          permalink: typeof raw.permalink === 'string' ? raw.permalink : null
        };
        musicCatalogCache.set(catalogId, { track, expiresAt: Date.now() + MUSIC_CATALOG_TTL });
        tracks.push({
          id: catalogId,
          title: track.title,
          artist: track.artist || '',
          album: track.album || '',
          duration: track.duration,
          format: track.format,
          permalink: track.permalink
        });
      }
      pruneMusicCaches();
      cached = { tracks, expiresAt: Date.now() + MUSIC_SEARCH_CACHE_TTL };
      musicSearchCache.set(cacheKey, cached);
    } catch (error) {
      const status = error && Number.isInteger(error.statusCode) ? error.statusCode : 502;
      const message = status === 429
        ? 'Audius is temporarily rate-limiting searches. Wait a little and try again.'
        : 'Audius search is temporarily unavailable. Try again in a moment.';
      return res.status(status === 429 ? 429 : 502).json({ error: message });
    }
  }
  return res.json({ tracks: cached.tracks });
});

async function resolveMusicAddonStream(track, forceRefresh = false) {
  if (!forceRefresh && track.streamUrl && track.streamUrlExpiresAt > Date.now() + 2000) {
    return { url: track.streamUrl, format: track.streamFormat || track.format };
  }
  // Official Audius stream endpoint redirects to an audio host. It is called server-side only.
  const url = musicAddonEndpoint('tracks/' + encodeURIComponent(track.sourceTrackId) + '/stream');
  if (AUDIUS_API_KEY) url.searchParams.set('api_key', AUDIUS_API_KEY);
  else url.searchParams.set('app_name', AUDIUS_APP_NAME);
  const streamUrl = await validatePublicAudioUrl(url.toString());
  track.streamUrl = streamUrl.toString();
  track.streamUrlExpiresAt = Date.now() + 45 * 1000;
  track.streamFormat = 'MP3';
  return { url: track.streamUrl, format: track.streamFormat };
}

async function fetchRelayedAudio(url, rangeHeader) {
  let current = url;
  for (let attempt = 0; attempt < 4; attempt++) {
    const checked = await validatePublicAudioUrl(current);
    const headers = { accept: 'audio/*, application/octet-stream;q=0.9, */*;q=0.5' };
    if (rangeHeader && /^bytes=(?:\d+-\d*|-\d+)$/.test(rangeHeader)) headers.range = rangeHeader;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MUSIC_ADDON_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(checked, { headers, redirect: 'manual', signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (response.body) await response.body.cancel().catch(() => {});
      if (!location) throw new Error('The audio source returned an invalid redirect.');
      current = new URL(location, checked).toString();
      continue;
    }
    return response;
  }
  throw new Error('The audio source redirected too many times.');
}

function mimeForMusicFormat(format) {
  const key = String(format || '').toLowerCase().replace(/^\./, '');
  return ({
    flac: 'audio/flac', mp3: 'audio/mpeg', mpeg: 'audio/mpeg',
    m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac',
    ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', wave: 'audio/wav',
    webm: 'audio/webm'
  })[key] || 'audio/mpeg';
}

function musicRetryAfterMs(response) {
  const value = response && response.headers ? response.headers.get('retry-after') : null;
  if (value && /^\d+$/.test(value.trim())) return Math.max(10000, Math.min(15 * 60 * 1000, Number(value.trim()) * 1000));
  if (value) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return Math.max(10000, Math.min(15 * 60 * 1000, timestamp - Date.now()));
  }
  return 60 * 1000;
}

function musicRateLimitError(host, response) {
  const waitMs = musicRetryAfterMs(response);
  const retryAt = Date.now() + waitMs;
  musicHostCooldowns.set(host, retryAt);
  const error = new Error('The audio source rate-limited the chat server (HTTP 429). The server will wait about ' +
    Math.ceil(waitMs / 1000) + ' seconds before trying that host again.');
  error.statusCode = 429;
  error.retryAt = retryAt;
  return error;
}

async function ensureAddonTrackCached(track) {
  if (track.relayCachePath) {
    try {
      await fs.promises.access(track.relayCachePath);
      return track.relayCachePath;
    } catch (_) {
      track.relayCachePath = null;
    }
  }
  if (track.relayCacheError && track.relayCacheRetryAt > Date.now()) {
    const error = new Error(track.relayCacheError);
    error.statusCode = track.relayCacheStatus || 502;
    error.retryAt = track.relayCacheRetryAt;
    throw error;
  }
  if (track.relayCachePromise) return track.relayCachePromise;

  track.relayCacheError = null;
  track.relayCacheRetryAt = 0;
  const task = (async () => {
    let upstream = null;
    let descriptor = null;
    let host = '';
    let tempPath = null;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        descriptor = await resolveMusicAddonStream(track, attempt > 0);
        const streamUrl = await validatePublicAudioUrl(descriptor.url);
        host = streamUrl.host.toLowerCase();
        const cooldownUntil = musicHostCooldowns.get(host) || 0;
        if (cooldownUntil > Date.now()) {
          const waitSeconds = Math.ceil((cooldownUntil - Date.now()) / 1000);
          const error = new Error('The audio host has rate-limited the chat server. Try again in about ' + waitSeconds + ' seconds.');
          error.statusCode = 429;
          error.retryAt = cooldownUntil;
          throw error;
        }
        upstream = await fetchRelayedAudio(streamUrl.toString(), null);
        if (attempt === 0 && [401, 403, 404, 410].includes(upstream.status)) {
          if (upstream.body) await upstream.body.cancel().catch(() => {});
          track.streamUrl = null;
          track.streamUrlExpiresAt = 0;
          upstream = null;
          continue;
        }
        break;
      }

      if (!upstream) throw new Error('The audio source did not respond.');
      const upstreamType = String(upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (upstream.status === 429) {
        if (upstream.body) await upstream.body.cancel().catch(() => {});
        throw musicRateLimitError(host, upstream);
      }
      if (!upstream.ok || upstream.status === 206) {
        if (upstream.body) await upstream.body.cancel().catch(() => {});
        throw new Error('The audio source returned HTTP ' + upstream.status + '.');
      }
      if (!upstream.body || upstreamType === 'text/html' || upstreamType === 'application/json' ||
          !(upstreamType.startsWith('audio/') || upstreamType === 'application/octet-stream' || upstreamType === 'video/webm')) {
        if (upstream.body) await upstream.body.cancel().catch(() => {});
        throw new Error('The source did not return a direct audio stream (HTTP ' + upstream.status +
          ', content type ' + (upstreamType || 'unknown') + ').');
      }

      tempPath = path.join(MUSIC_RELAY_CACHE_DIR, 'track-' + track.id + '-' + crypto.randomBytes(8).toString('hex') + '.cache');
      track.relayCacheTempPath = tempPath;
      let bytes = 0;
      let timedOut = false;
      const source = Readable.fromWeb(upstream.body);
      const limiter = new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > MUSIC_MAX_RELAY_CACHE_BYTES) {
            callback(new Error('This audio file exceeds the server cache limit of 120 MB.'));
            return;
          }
          callback(null, chunk);
        }
      });
      const timeout = setTimeout(() => {
        timedOut = true;
        source.destroy(new Error('The server timed out while preparing the audio cache.'));
      }, MUSIC_CACHE_DOWNLOAD_TIMEOUT_MS);
      try {
        await pipeline(source, limiter, fs.createWriteStream(tempPath, { flags: 'wx' }));
      } finally {
        clearTimeout(timeout);
      }
      if (timedOut) throw new Error('The server timed out while preparing the audio cache.');
      if (!bytes) throw new Error('The audio source returned an empty file.');
      if (findMusicTrack(track.id) !== track) throw new Error('This track is no longer in the shared queue.');

      track.relayCachePath = tempPath;
      track.relayCacheTempPath = null;
      track.relayCacheBytes = bytes;
      track.relayCacheMimeType = upstreamType.startsWith('audio/') ? upstreamType : mimeForMusicFormat(descriptor && descriptor.format || track.format);
      track.relayCacheError = null;
      track.relayCacheRetryAt = 0;
      track.relayCacheStatus = 200;
      console.log('[music] one server-side audio fetch cached (' + bytes + ' bytes); listeners will use the local cache');
      if (musicCurrent === track && !musicPlayback.isPlaying && !musicPausedByAdmin) {
        const readyAt = Date.now();
        musicPlayback = { isPlaying: true, position: 0, startedAt: readyAt, changedBy: null };
      }
      if (musicCurrent === track) broadcastMusicState();
      return tempPath;
    } catch (error) {
      if (tempPath) await fs.promises.unlink(tempPath).catch(() => {});
      track.relayCacheTempPath = null;
      const status = error && Number.isInteger(error.statusCode) ? error.statusCode : 502;
      const retryAt = error && Number.isFinite(error.retryAt) ? error.retryAt : Date.now() + 8000;
      const rawMessage = error && typeof error.message === 'string' ? error.message : 'The audio source could not be fetched.';
      const safeMessage = safeMusicDiagnosticMessage(error);
      track.relayCacheError = safeMessage || rawMessage;
      track.relayCacheRetryAt = retryAt;
      track.relayCacheStatus = status;
      throw error;
    }
  })();
  track.relayCachePromise = task;
  try {
    return await task;
  } finally {
    if (track.relayCachePromise === task) track.relayCachePromise = null;
  }
}

function prepareCurrentMusicTrack(track) {
  if (!track || track.source !== 'addon' || track.relayCachePath) return;
  ensureAddonTrackCached(track).catch(error => {
    console.log('[music] automatic track preparation failed: ' + safeMusicDiagnosticMessage(error));
    if (musicCurrent === track) broadcastMusicState();
  });
}

function serveCachedAddonAudio(track, req, res) {
  const filePath = track.relayCachePath;
  const total = Number(track.relayCacheBytes) || 0;
  if (!filePath || total <= 0) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).json({ error: 'The server audio cache is not ready.' });
  }
  res.setHeader('Content-Type', track.relayCacheMimeType || mimeForMusicFormat(track.format));
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', 'inline; filename="shared-track.' + (String(track.format || 'audio').toLowerCase().replace(/[^a-z0-9]/g, '') || 'audio') + '"');

  let start = 0, end = total - 1, status = 200;
  const rangeHeader = req.headers.range;
  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (!match || (!match[1] && !match[2])) {
      res.setHeader('Content-Range', 'bytes */' + total);
      return res.status(416).end();
    }
    if (!match[1]) {
      const suffix = Number(match[2]);
      if (!Number.isSafeInteger(suffix) || suffix <= 0) {
        res.setHeader('Content-Range', 'bytes */' + total);
        return res.status(416).end();
      }
      start = Math.max(0, total - suffix);
    } else {
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : total - 1;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= total || end < start) {
      res.setHeader('Content-Range', 'bytes */' + total);
      return res.status(416).end();
    }
    end = Math.min(end, total - 1);
    status = 206;
    res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + total);
  }

  res.status(status);
  res.setHeader('Content-Length', String(end - start + 1));
  if (req.method === 'HEAD') return res.end();
  const source = fs.createReadStream(filePath, { start, end });
  res.on('close', () => { if (!res.writableEnded) source.destroy(); });
  source.on('error', () => { if (!res.headersSent) res.status(502).end(); else if (!res.writableEnded) res.destroy(); });
  source.pipe(res);
}

async function streamMusicAddonTrack(track, req, res) {
  try {
    await ensureAddonTrackCached(track);
    return serveCachedAddonAudio(track, req, res);
  } catch (error) {
    const status = error && Number.isInteger(error.statusCode) ? error.statusCode : 502;
    if (status === 429 && Number.isFinite(error.retryAt)) res.setHeader('Retry-After', String(Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1000))));
    console.log('[music] server-side audio preparation failed (HTTP ' + status + '): ' + safeMusicDiagnosticMessage(error));
    if (!res.headersSent) return res.status(status).set('Cache-Control', 'no-store').json({
      error: safeMusicDiagnosticMessage(error) || 'The server could not prepare audio from this source.'
    });
    if (!res.writableEnded) res.destroy();
  }
}

function safeMusicDiagnosticMessage(error) {
  const message = error && typeof error.message === 'string' ? error.message : String(error || 'unknown error');
  const code = error && (error.code || (error.cause && error.cause.code));
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'The chat server could not resolve the audio host in DNS.';
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ECONNREFUSED') return 'The chat server could not connect to the audio host.';
  return message
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL hidden]')
    .replace(/([?&](?:token|signature|sig|key|auth|expires)=)[^&\s]*/gi, '$1[hidden]')
    .slice(0, 200);
}

async function inspectMusicAddonStream(track) {
  if (track.relayCacheError && track.relayCacheRetryAt > Date.now()) {
    const error = new Error(track.relayCacheError);
    error.statusCode = track.relayCacheStatus || 502;
    error.retryAt = track.relayCacheRetryAt;
    throw error;
  }
  await ensureAddonTrackCached(track);
  return {
    ok: true,
    status: 200,
    contentType: track.relayCacheMimeType || mimeForMusicFormat(track.format),
    rangeSupported: true,
    cachedBytes: track.relayCacheBytes
  };
}

app.get('/api/music/stream-check/:id', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const id = Number(req.params.id);
  const track = Number.isSafeInteger(id) && id > 0 ? findMusicTrack(id) : null;
  if (!track) return res.status(404).json({ ok: false, error: 'This track is no longer in the shared queue.' });
  if (track.source !== 'addon') {
    return res.json({ ok: true, source: 'upload', message: 'The uploaded track is stored on this server.' });
  }
  const cached = musicStreamCheckCache.get(id);
  if (cached && cached.expiresAt > Date.now()) {
    return res.status(cached.result.ok ? 200 : 502).json(cached.result);
  }
  try {
    const result = await inspectMusicAddonStream(track);
    musicStreamCheckCache.set(id, { expiresAt: Date.now() + MUSIC_STREAM_CHECK_TTL, result });
    console.log('[music] server-side stream check OK: HTTP ' + result.status + ', ' + result.contentType);
    return res.json(result);
  } catch (error) {
    const detail = safeMusicDiagnosticMessage(error);
    console.log('[music] server-side stream check failed: ' + detail);
    const result = { ok: false, error: detail || 'The server could not obtain playable audio from this provider.' };
    musicStreamCheckCache.set(id, { expiresAt: Date.now() + 5000, result });
    return res.status(502).json(result);
  }
});

// The chat server serves either an uploaded track or a relayed stream. Range requests
// are passed upstream, so listeners' browsers never connect to the music addon/media host.
app.get('/music/stream/:id', async (req, res) => {
  const id = Number(req.params.id);
  const track = Number.isSafeInteger(id) && id > 0 ? findMusicTrack(id) : null;
  if (!track) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).json({ error: 'This track is no longer available on the server.' });
  }
  if (track.source === 'addon') {
    if (track !== musicCurrent) return res.status(409).json({ error: 'Only the current shared track can be streamed.' });
    return streamMusicAddonTrack(track, req, res);
  }
  if (!Buffer.isBuffer(track.audio)) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).json({ error: 'This track is no longer available on the server.' });
  }

  const audio = track.audio;
  res.setHeader('Content-Type', track.mimeType);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', 'inline; filename="' + track.fileName + '"');

  const rangeNotSatisfiable = () => {
    res.setHeader('Content-Range', 'bytes */' + audio.length);
    return res.status(416).end();
  };
  const rangeHeader = req.headers.range;
  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (!match || (!match[1] && !match[2])) return rangeNotSatisfiable();
    let start, end;
    if (!match[1]) {
      const suffixLength = Number(match[2]);
      if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return rangeNotSatisfiable();
      start = Math.max(0, audio.length - suffixLength);
      end = audio.length - 1;
    } else {
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : audio.length - 1;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        start < 0 || start >= audio.length || end < start) return rangeNotSatisfiable();
    end = Math.min(end, audio.length - 1);
    res.status(206);
    res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + audio.length);
    res.setHeader('Content-Length', String(end - start + 1));
    if (req.method === 'HEAD') return res.end();
    return res.end(audio.subarray(start, end + 1));
  }

  res.setHeader('Content-Length', String(audio.length));
  if (req.method === 'HEAD') return res.end();
  return res.end(audio);
});

// Server-owned music scheduler: it runs regardless of how many sockets are in
// #music (including zero). Track duration advances the queue even with no listeners;
// browsers only attach to the current position when they join the room.
const musicSyncTimer = setInterval(() => {
  if (!musicPlayback.isPlaying || !musicCurrent) return;
  const now = Date.now();
  const duration = Number(musicCurrent.duration);
  if (Number.isFinite(duration) && duration > 0 && getMusicPosition(now) >= duration) {
    advanceMusicTrack(now, 'natural track end');
  }
  if (musicPlayback.isPlaying && musicCurrent) {
    io.to('music').emit('music:sync', getMusicPlayback());
  }
}, 1000);
if (typeof musicSyncTimer.unref === 'function') musicSyncTimer.unref();

function removeVoiceParticipant(socketId) {
  const roster = voiceParticipants.get('voice');
  if (!roster || !roster.has(socketId)) return;
  roster.delete(socketId);
  for (const peerId of roster.keys()) {
    io.to(peerId).emit('voice:peer-left', { id: socketId });
  }
  if (!roster.size) voiceParticipants.delete('voice');
  broadcastVoiceState();
  console.log('[voice] participant left; active: ' + getVoiceRoster().length);
}

io.on('connection', (socket) => {
  console.log('[online] ' + io.engine.clientsCount);
  let room = 'general', last = 0, lastReact = 0, lastReport = 0, lastText = '', lastTextAt = 0, recent = [];
  const blocked = () => (offline || socket.data.banned) && !socket.data.admin;
  const key = () => socket.data.tok || socket.id;

  socket.on('join', (d) => {
    const requestedAdminToken = d && typeof d.adminToken === 'string' ? d.adminToken : '';
    if (/^[a-f0-9]{64}$/.test(requestedAdminToken) && adminSessions.has(requestedAdminToken)) {
      socket.data.admin = true;
      socket.data.adminToken = requestedAdminToken;
    } else {
      socket.data.admin = false;
      socket.data.adminToken = null;
      if (requestedAdminToken) socket.emit('admin:session-invalid');
    }
    const nextRoom = roomName(d && d.room);
    if (socket.rooms.has(room) && room !== nextRoom) {
      removeVoiceParticipant(socket.id);
      endScreenShare(socket.id);
      socket.leave(room);
    }
    room = nextRoom;
    socket.data.tok = clean(d && d.tok, 32);
    const existingBan = activeUserBan(socket.data.tok);
    if (existingBan) {
      socket.data.banned = true;
      socket.emit('user:banned', { expiresAt: existingBan.expiresAt, reason: existingBan.reason });
      socket.emit('sys', existingBan.expiresAt ? 'You are banned until ' + new Date(existingBan.expiresAt).toLocaleString() + '.' : 'You are banned from this server until it restarts.');
      return;
    }
    socket.data.banned = false;
    socket.join(room);
    if (socket.data.admin) socket.emit('admin', true);
    socket.emit('config', { images: imagesAllowed(room) });
    if (blocked()) return socket.emit('closed', true);
    const now = Date.now();
    const history = (rooms[room] || [])
      .filter(m => m.imageApproved !== false && (room === 'announcements' || now - m.t < TTL))
      .map(m => ({ ...pub(m), own: !!m.tok && m.tok === key() }));
    // Global banners remain temporary. Moderator posts written directly in
    // #announcements have their own history and do not expire with normal chat.
    if (room !== 'announcements' && latestAnnouncement && now - latestAnnouncement.t < ANNOUNCEMENT_TTL) {
      history.push(latestAnnouncement);
    }
    if (room === 'announcements') {
      history.push(...OFFICIAL_ANNOUNCEMENT_INFO.map((m, i) => ({
        ...m,
        id: 'official-info-' + (i + 1),
        t: now
      })));
    }
    socket.emit('history', history);
    if (room === 'voice') socket.emit('voice:state', { participants: getVoiceRoster() });
    if (room === 'music') socket.emit('music:state', getMusicState());
    const activeShare = screenSharers[room];
    socket.emit('screen:state', activeShare
      ? { sharerId: activeShare.socketId, name: activeShare.name }
      : { sharerId: null });
    io.to(room).emit('online', io.sockets.adapter.rooms.get(room)?.size || 1);
  });

  // Screen sharing signalling. Video stays peer-to-peer; the server only routes setup messages.
  socket.on('screen:state', () => {
    const share = screenSharers[room];
    socket.emit('screen:state', share
      ? { sharerId: share.socketId, name: share.name }
      : { sharerId: null });
  });

  socket.on('screen:start', (d) => {
    const now = Date.now();
    if (blocked()) return socket.emit('screen:error', { message: 'The chat is offline.' });
    if (timeouts[key()] > now) return socket.emit('screen:error', { message: 'You cannot start screen sharing while timed out. Try again in ' + left(timeouts[key()]) + '.' });
    const active = screenSharers[room];
    if (active && active.socketId !== socket.id && io.sockets.sockets.has(active.socketId)) {
      return socket.emit('screen:error', { message: 'Someone is already sharing their screen in this room.' });
    }
    if (active && active.socketId !== socket.id) delete screenSharers[room];
    const requestedName = clean(d && d.name, 20);
    const shareName = socket.data.admin ? 'Server Admin' : (safeName(requestedName) || 'A user');
    screenSharers[room] = { socketId: socket.id, name: shareName, tok: key(), startedAt: Date.now(), viewers: new Set() };
    socket.emit('screen:start:accepted', { sharerId: socket.id, room });
    io.to(room).emit('screen:started', { sharerId: socket.id, name: shareName });
    console.log('[screen] sharing started in room ' + room);
  });

  socket.on('screen:stop', () => {
    endScreenShare(socket.id);
  });

  socket.on('screen:watch', () => {
    const share = screenSharers[room];
    if (!share || share.socketId === socket.id || !socket.rooms.has(room)) {
      return socket.emit('screen:state', share
        ? { sharerId: share.socketId, name: share.name }
        : { sharerId: null });
    }
    const sharer = io.sockets.sockets.get(share.socketId);
    if (!sharer || !sharer.rooms.has(room)) {
      delete screenSharers[room];
      io.to(room).emit('screen:stopped', { sharerId: share.socketId });
      return;
    }
    removeScreenViewer(socket.id, room);
    share.viewers.add(socket.id);
    addScreenViewer(socket.id, room);
    sharer.emit('screen:viewer', { viewerId: socket.id });
  });

  socket.on('screen:unwatch', (d) => {
    const screenRoom = d && typeof d.room === 'string' ? roomName(d.room) : room;
    const share = screenSharers[screenRoom];
    if (share && share.viewers && share.viewers.has(socket.id)) {
      removeScreenViewer(socket.id, screenRoom);
      const sharer = io.sockets.sockets.get(share.socketId);
      if (sharer) sharer.emit('screen:viewer-stopped', { viewerId: socket.id });
    }
    socket.emit('screen:unwatched', { room: screenRoom });
  });

  // Admin-only monitoring of any active room, without joining that room.
  socket.on('screen:admin:watch', (d) => {
    if (!socket.data.admin) return;
    const requestedId = d && typeof d.sharerId === 'string' ? d.sharerId : '';
    const found = Object.entries(screenSharers).find(([, share]) => share.socketId === requestedId);
    if (!found) return socket.emit('screen:admin:error', { message: 'That screen share is no longer active.' });
    const [shareRoom, share] = found;
    removeScreenViewer(socket.id, shareRoom);
    share.viewers.add(socket.id);
    addScreenViewer(socket.id, shareRoom);
    socket.emit('screen:admin:monitor-ready', {
      room: shareRoom,
      sharerId: share.socketId,
      name: share.name
    });
    const sharer = io.sockets.sockets.get(share.socketId);
    if (sharer) sharer.emit('screen:viewer', { viewerId: socket.id });
  });

  socket.on('screen:admin:unwatch', (d) => {
    // A socket may unregister only its own viewer entry, including during logout.
    const screenRoom = d && typeof d.room === 'string' ? roomName(d.room) : '';
    const sharerId = d && typeof d.sharerId === 'string' ? d.sharerId : '';
    const share = screenRoom ? screenSharers[screenRoom] : null;
    if (screenRoom) {
      removeScreenViewer(socket.id, screenRoom);
      if (share && sharerId === share.socketId) {
        const sharer = io.sockets.sockets.get(share.socketId);
        if (sharer) sharer.emit('screen:viewer-stopped', { viewerId: socket.id });
      }
    } else {
      removeScreenViewer(socket.id);
    }
    socket.emit('screen:admin:monitor-ended', {});
  });

  socket.on('screen:admin:stop', (d) => {
    if (!socket.data.admin) return;
    const requestedId = d && typeof d.sharerId === 'string' ? d.sharerId : '';
    const found = Object.entries(screenSharers).find(([, share]) => share.socketId === requestedId);
    if (!found) return socket.emit('screen:admin:action-result', { ok: false, message: 'That screen share is no longer active.' });
    const [shareRoom, share] = found;
    const sharer = io.sockets.sockets.get(share.socketId);
    if (sharer) sharer.emit('screen:moderated-stop', { message: 'A server moderator stopped your screen share.' });
    endScreenShare(share.socketId);
    socket.emit('screen:admin:action-result', { ok: true, message: 'Screen sharing stopped in #' + shareRoom + '.' });
  });

  socket.on('screen:admin:timeout', (d) => {
    if (!socket.data.admin) return;
    const requestedId = d && typeof d.sharerId === 'string' ? d.sharerId : '';
    const mins = Math.min(Math.max(parseInt(d && d.minutes, 10) || 10, 1), 1440);
    const found = Object.entries(screenSharers).find(([, share]) => share.socketId === requestedId);
    if (!found) return socket.emit('screen:admin:action-result', { ok: false, message: 'That screen share is no longer active.' });
    const [shareRoom, share] = found;
    const sharer = io.sockets.sockets.get(share.socketId);
    timeouts[share.tok || share.socketId] = Date.now() + mins * 60000;
    if (sharer) {
      sharer.emit('screen:moderated-timeout', { minutes: mins, room: shareRoom });
      sharer.emit('sys', 'A server moderator stopped your screen share and timed you out for ' + mins + ' minute(s).');
    }
    endScreenShare(share.socketId);
    console.log('[mod] screen-share timeout set for ' + mins + ' min in room ' + shareRoom);
    socket.emit('screen:admin:action-result', { ok: true, message: 'Stopped screen sharing and timed out the user for ' + mins + ' minute(s).' });
  });

  socket.on('screen:signal', (d) => {
    if (!d || typeof d.to !== 'string' || d.to === socket.id) return;

    // Determine the stream from the authenticated sharer or registered viewer.
    let share = null, shareRoom = null, senderIsSharer = false;
    // Match by destination first so an admin can share in one room and monitor another.
    for (const [candidateRoom, candidateShare] of Object.entries(screenSharers)) {
      const viewerRooms = screenViewerRooms.get(d.to);
      if (candidateShare.socketId === socket.id &&
          candidateShare.viewers && candidateShare.viewers.has(d.to) &&
          viewerRooms && viewerRooms.has(candidateRoom)) {
        share = candidateShare; shareRoom = candidateRoom; senderIsSharer = true; break;
      }
    }
    if (senderIsSharer) {
      const viewerRooms = screenViewerRooms.get(d.to);
      if (!share.viewers || !share.viewers.has(d.to) || !viewerRooms || !viewerRooms.has(shareRoom)) return;
    } else {
      const viewerRooms = screenViewerRooms.get(socket.id);
      const viewerEntry = Object.entries(screenSharers).find(([candidateRoom, candidateShare]) =>
        candidateShare.socketId === d.to && candidateShare.viewers &&
        candidateShare.viewers.has(socket.id) && viewerRooms && viewerRooms.has(candidateRoom));
      if (!viewerEntry) return;
      shareRoom = viewerEntry[0];
      share = viewerEntry[1];
    }
    const target = io.sockets.sockets.get(d.to);
    if (!target) return;
    // Admin monitors can be outside the room, but only while explicitly registered as a viewer.
    if (senderIsSharer) {
      const viewerRooms = screenViewerRooms.get(d.to);
      if (!viewerRooms || !viewerRooms.has(shareRoom)) return;
    } else if (!target.rooms.has(shareRoom)) return;

    const payload = { from: socket.id, room: shareRoom };
    if (d.description !== undefined) {
      const desc = d.description;
      if (!desc || !['offer', 'answer'].includes(desc.type) || typeof desc.sdp !== 'string' || desc.sdp.length > 100000) return;
      if (senderIsSharer && desc.type !== 'offer') return;
      if (!senderIsSharer && desc.type !== 'answer') return;
      payload.description = { type: desc.type, sdp: desc.sdp };
    }
    if (d.candidate !== undefined && d.candidate !== null) {
      const c = d.candidate;
      if (!c || typeof c.candidate !== 'string' || c.candidate.length > 4096) return;
      payload.candidate = {
        candidate: c.candidate,
        sdpMid: typeof c.sdpMid === 'string' ? c.sdpMid.slice(0, 256) : null,
        sdpMLineIndex: Number.isInteger(c.sdpMLineIndex) ? c.sdpMLineIndex : null,
        usernameFragment: typeof c.usernameFragment === 'string' ? c.usernameFragment.slice(0, 256) : undefined
      };
    }
    if (!payload.description && !payload.candidate) return;
    target.emit('screen:signal', payload);
  });

  // Voice chat is limited to the dedicated #voice channel. Audio stays peer-to-peer.
  socket.on('voice:join', (d) => {
    if (blocked()) return socket.emit('voice:error', { message: 'The chat is offline.' });
    if (room !== 'voice' || !socket.rooms.has('voice')) {
      return socket.emit('voice:error', { message: 'Join the #voice channel before entering voice chat.' });
    }
    if (timeouts[key()] > Date.now()) {
      return socket.emit('voice:error', { message: 'You are timed out and cannot join voice chat yet.' });
    }
    let roster = voiceParticipants.get('voice');
    if (!roster) {
      roster = new Map();
      voiceParticipants.set('voice', roster);
    }
    if (!roster.has(socket.id) && roster.size >= MAX_VOICE_USERS) {
      return socket.emit('voice:error', { message: 'Voice chat is full (maximum ' + MAX_VOICE_USERS + ' people). Please try again later.' });
    }
    const userName = safeName(d && d.name);
    const alreadyJoined = roster.has(socket.id);
    roster.set(socket.id, { name: userName, joinedAt: Date.now() });
    socket.emit('voice:joined', {
      room: 'voice',
      participants: [...roster.entries()]
        .filter(([id]) => id !== socket.id)
        .map(([id, participant]) => ({ id, name: participant.name }))
    });
    if (!alreadyJoined) {
      for (const peerId of roster.keys()) {
        if (peerId !== socket.id) io.to(peerId).emit('voice:peer-joined', { id: socket.id, name: userName });
      }
      broadcastVoiceState();
      console.log('[voice] participant joined; active: ' + roster.size);
    }
  });

  socket.on('voice:leave', () => {
    removeVoiceParticipant(socket.id);
  });

  socket.on('voice:signal', (d) => {
    const roster = voiceParticipants.get('voice');
    if (room !== 'voice' || !roster || !roster.has(socket.id) ||
        !d || typeof d.to !== 'string' || d.to === socket.id || !roster.has(d.to)) return;
    const payload = { from: socket.id, name: roster.get(socket.id).name };

    if (d.description) {
      const type = d.description.type;
      const sdp = d.description.sdp;
      if (!['offer', 'answer'].includes(type) || typeof sdp !== 'string' || sdp.length > 100000) return;
      payload.description = { type, sdp };
    } else if (d.candidate) {
      const candidate = d.candidate;
      if (typeof candidate.candidate !== 'string' || candidate.candidate.length > 2048) return;
      payload.candidate = {
        candidate: candidate.candidate,
        sdpMid: typeof candidate.sdpMid === 'string' ? candidate.sdpMid.slice(0, 128) : null,
        sdpMLineIndex: Number.isInteger(candidate.sdpMLineIndex) ? candidate.sdpMLineIndex : null,
        usernameFragment: typeof candidate.usernameFragment === 'string' ? candidate.usernameFragment.slice(0, 256) : undefined
      };
    } else {
      return;
    }

    const target = io.sockets.sockets.get(d.to);
    if (target) target.emit('voice:signal', payload);
  });

  // Queue an opaque catalogue result created by this server's search endpoint.
  socket.on('music:add-catalog', (d) => {
    const now = Date.now();
    if (room !== 'music' || !socket.rooms.has('music')) return;
    if (blocked()) return socket.emit('music:error', { message: 'The chat is offline.' });
    if (timeouts[key()] > now) return socket.emit('music:error', { message: 'You are timed out and cannot add tracks right now.' });
    const catalogId = clean(d && d.catalogId, 64);
    if (!/^[a-f0-9]{32}$/.test(catalogId) || now - (socket.data.musicLastAdd || 0) < 2500) {
      return socket.emit('music:error', { message: 'Search for that track again, then try adding it.', catalogId });
    }
    pruneMusicCaches();
    const entry = musicCatalogCache.get(catalogId);
    if (!entry || entry.expiresAt <= now) {
      return socket.emit('music:error', { message: 'That search result expired. Search again before adding it.', catalogId });
    }
    const selected = entry.track;
    if ([musicCurrent, ...musicQueue].some(track => track && track.source === 'addon' && track.sourceTrackId === selected.sourceId)) {
      return socket.emit('music:error', { message: 'That track is already in the current song or queue.', catalogId });
    }
    const sameUserCount = [musicCurrent, ...musicQueue].filter(track => track && track.addedById === socket.id).length;
    if (sameUserCount >= MUSIC_MAX_PER_USER) {
      return socket.emit('music:error', { message: 'You can have up to ' + MUSIC_MAX_PER_USER + ' tracks in the shared list at once.', catalogId });
    }
    if ((musicCurrent ? 1 : 0) + musicQueue.length >= MUSIC_MAX_TRACKS) {
      return socket.emit('music:error', { message: 'The shared list is full (maximum ' + MUSIC_MAX_TRACKS + ' tracks).', catalogId });
    }

    const track = {
      id: ++musicTrackId,
      source: 'addon',
      sourceTrackId: selected.sourceId,
      title: selected.title,
      artist: selected.artist,
      album: selected.album,
      duration: Number.isFinite(Number(selected.duration)) && Number(selected.duration) > 0 ? Number(selected.duration) : null,
      format: selected.format,
      permalink: selected.permalink || null,
      addedBy: safeName(d && d.name),
      addedById: socket.id,
      addedAt: now,
      streamUrl: null,
      streamUrlExpiresAt: 0
    };
    socket.data.musicLastAdd = now;
    queueMusicTrack(track, now);
    broadcastMusicState();
    socket.emit('music:added', { id: track.id, source: 'addon', catalogId });
    console.log('[music] catalogue track queued by ' + track.addedBy + '; queued total ' + ((musicCurrent ? 1 : 0) + musicQueue.length));
  });

  // Shared server-hosted audio queue. Only upload audio you have permission to share.
  socket.on('music:upload', (d) => {
    const now = Date.now();
    if (room !== 'music' || !socket.rooms.has('music')) return;
    if (blocked()) return socket.emit('music:error', { message: 'The chat is offline.' });
    if (timeouts[key()] > now) return socket.emit('music:error', { message: 'You are timed out and cannot upload tracks right now.' });
    if (!d || typeof d.fileName !== 'string' || !d.audio || now - (socket.data.musicLastAdd || 0) < 2500) {
      return socket.emit('music:error', { message: 'Please wait a moment and select an audio file.' });
    }

    let audio;
    if (Buffer.isBuffer(d.audio)) audio = Buffer.from(d.audio);
    else if (d.audio instanceof ArrayBuffer) audio = Buffer.from(d.audio);
    else if (ArrayBuffer.isView(d.audio)) audio = Buffer.from(d.audio.buffer, d.audio.byteOffset, d.audio.byteLength);
    else return socket.emit('music:error', { message: 'The audio upload could not be read. Please try another file.' });

    if (!audio.length) return socket.emit('music:error', { message: 'That audio file is empty.' });
    if (audio.length > MUSIC_MAX_FILE_BYTES) {
      return socket.emit('music:error', { message: 'Each audio file must be 8 MB or smaller.' });
    }

    const fileName = clean(d.fileName, 180).split('/').pop();
    const extensionMatch = /\.([a-z0-9]+)$/i.exec(fileName);
    const extension = extensionMatch ? '.' + extensionMatch[1].toLowerCase() : '';
    const mimeType = MUSIC_TYPES[extension];
    if (!mimeType) {
      return socket.emit('music:error', { message: 'Supported formats: MP3, M4A, AAC, OGG, OPUS, WAV, WEBM and FLAC.' });
    }
    const duration = Number(d.duration);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 86400) {
      return socket.emit('music:error', { message: 'The browser could not read this audio file’s duration, so the shared queue cannot auto-advance it. Try a supported MP3, M4A, OGG or WAV file.' });
    }

    const sameUserCount = [musicCurrent, ...musicQueue].filter(track => track && track.addedById === socket.id).length;
    if (sameUserCount >= MUSIC_MAX_PER_USER) {
      return socket.emit('music:error', { message: 'You can have up to ' + MUSIC_MAX_PER_USER + ' tracks in the shared list at once.' });
    }
    const hash = crypto.createHash('sha256').update(audio).digest('hex');
    if ((musicCurrent && musicCurrent.hash === hash) ||
        musicQueue.some(track => track.hash === hash)) {
      return socket.emit('music:error', { message: 'That audio file is already in the current track or queue.' });
    }
    if ((musicCurrent ? 1 : 0) + musicQueue.length >= MUSIC_MAX_TRACKS) {
      return socket.emit('music:error', { message: 'The shared list is full (maximum ' + MUSIC_MAX_TRACKS + ' tracks).' });
    }
    if (musicStoredBytes + audio.length > MUSIC_MAX_STORED_BYTES) {
      return socket.emit('music:error', { message: 'The server audio memory limit has been reached. Skip a track or wait before uploading more.' });
    }

    const title = clean(d.title, 100) || clean(fileName.replace(/\.[^.]+$/, ''), 100) || 'Uploaded audio';
    const track = {
      id: ++musicTrackId,
      title,
      addedBy: safeName(d.name),
      addedById: socket.id,
      addedAt: now,
      extension,
      mimeType,
      fileName: 'track-' + musicTrackId + extension,
      hash,
      duration,
      audio
    };
    socket.data.musicLastAdd = now;
    musicStoredBytes += audio.length;
    queueMusicTrack(track, now);
    broadcastMusicState();
    socket.emit('music:added', { id: track.id });
    console.log('[music] audio track added by ' + track.addedBy + '; memory ' + musicStoredBytes + ' bytes; queued total ' + ((musicCurrent ? 1 : 0) + musicQueue.length));
  });

  socket.on('music:control', (d) => {
    const now = Date.now();
    if (room !== 'music' || !socket.rooms.has('music')) return;
    if (!socket.data.admin) {
      return socket.emit('music:error', { message: 'Only admins can control shared playback. You can still add tracks and listen.' });
    }
    if (blocked()) return socket.emit('music:error', { message: 'The chat is offline.' });
    if (timeouts[key()] > now) return socket.emit('music:error', { message: 'You are timed out and cannot control playback.' });
    if (!musicCurrent || !d || Number(d.trackId) !== musicCurrent.id) {
      return socket.emit('music:state', getMusicState());
    }
    if (now - (socket.data.musicLastControl || 0) < 200) return;
    socket.data.musicLastControl = now;

    const action = d.action;
    const rawPosition = Number(d.position);
    const position = Number.isFinite(rawPosition) ? Math.max(0, Math.min(rawPosition, 86400)) : null;

    if (action === 'play') {
      if (musicCurrent.source === 'addon' && !musicCurrent.relayCachePath) {
        return socket.emit('music:error', { message: 'The server is still preparing the shared audio. Try again when it is ready.' });
      }
      if (musicPlayback.isPlaying) return socket.emit('music:state', getMusicState());
      musicPausedByAdmin = false;
      musicPlayback = {
        isPlaying: true,
        position: position === null ? getMusicPosition(now) : position,
        startedAt: now,
        changedBy: socket.id
      };
    } else if (action === 'pause') {
      if (!musicPlayback.isPlaying) return socket.emit('music:state', getMusicState());
      musicPausedByAdmin = true;
      musicPlayback = {
        isPlaying: false,
        position: getMusicPosition(now),
        startedAt: null,
        changedBy: socket.id
      };
    } else if (action === 'seek') {
      if (position === null) return socket.emit('music:error', { message: 'Could not synchronize the requested position.' });
      musicPlayback = {
        isPlaying: musicPlayback.isPlaying,
        position,
        startedAt: musicPlayback.isPlaying ? now : null,
        changedBy: socket.id
      };
    } else {
      return;
    }
    broadcastMusicState();
  });

  socket.on('music:sync-request', (d) => {
    const now = Date.now();
    if (room !== 'music' || !socket.rooms.has('music') || blocked()) return;
    if (now - (socket.data.musicLastSyncRequest || 0) < 1500) return;
    socket.data.musicLastSyncRequest = now;
    const requestId = Number.isSafeInteger(d && d.requestId) ? d.requestId : null;
    socket.emit('music:sync', { ...getMusicPlayback(), requestId });
  });

  socket.on('music:ended', (d) => {
    const now = Date.now();
    if (room !== 'music' || !socket.rooms.has('music') || !musicCurrent || !d ||
        Number(d.trackId) !== musicCurrent.id || blocked() || !musicPlayback.isPlaying) return;
    const duration = Number(musicCurrent.duration);
    // A client cannot force-skip: only admins may signal early completion.
    // Non-admin "ended" events are accepted only after the shared clock reaches the known track length.
    if (!socket.data.admin &&
        (!Number.isFinite(duration) || duration <= 0 || getMusicPosition(now) < duration - 1.5)) return;
    if (Number.isFinite(duration) && duration > 0 && getMusicPosition(now) < duration - 1.5 && !socket.data.admin) return;
    advanceMusicTrack(now, socket.data.admin ? 'admin ended event' : 'natural track end');
  });

  socket.on('music:next', () => {
    const now = Date.now();
    if (room !== 'music' || !socket.rooms.has('music')) return;
    if (!socket.data.admin) return socket.emit('music:error', { message: 'Only admins can skip the current track.' });
    if (blocked()) return socket.emit('music:error', { message: 'The chat is offline.' });
    if (timeouts[key()] > now) return socket.emit('music:error', { message: 'You are timed out and cannot control the music queue.' });
    if (now - musicLastSkipAt < 3000) {
      return socket.emit('music:error', { message: 'Please wait a few seconds before changing the current track.' });
    }
    if (!musicQueue.length) {
      return socket.emit('music:error', { message: 'There are no more tracks in the queue yet.' });
    }
    advanceMusicTrack(now, 'admin skip');
  });

  socket.on('msg', (d) => {
    const now = Date.now();
    if (socket.data.banned && !socket.data.admin) return socket.emit('sys', 'You are banned from this server.');
    const gap = socket.data.admin ? 500 : Math.max(500, slow * 1000);
    if (now - last < gap) { if (slow && !socket.data.admin && now - last >= 500) socket.emit('sys', 'Slow mode: please wait a moment.'); return; }
    const text = clean(d && d.text, 500);

    // Login and moderator commands are control actions, not stored chat text.
    if (text === '/admin' || text.startsWith('/admin ')) {
      last = now;
      const r = login(text.slice(6).trim());
      if (r === 'ok') {
        let sessionToken = socket.data.adminToken;
        if (!sessionToken || !adminSessions.has(sessionToken)) sessionToken = issueAdminSession();
        socket.data.admin = true;
        socket.data.adminToken = sessionToken;
        socket.emit('admin:session', sessionToken);
        socket.emit('admin', true);
        socket.emit('sys', 'Logged in as moderator. You will stay logged in until the server restarts or you log out.');
      } else socket.emit('sys', LOGIN_MSG[r]);
      return;
    }
    const [cmd, ...rest] = text.split(' ');
    if (socket.data.admin && ADMIN_CMDS.includes(cmd)) {
      last = now;
      return adminCommand(socket, cmd.slice(1), rest.join(' ').trim(), room);
    }

    if (room === 'announcements' && !socket.data.admin) {
      return socket.emit('sys', 'The #announcements channel is read-only. Only moderators can post there.');
    }
    if (blocked()) return socket.emit('sys', 'Chat is offline or your account is banned.');
    if (silenced && !socket.data.admin) return socket.emit('sys', 'Only moderators can send messages right now.');
    if (timeouts[key()] > now) return socket.emit('sys', 'You are timed out for ' + left(timeouts[key()]) + '.');

    // Slash commands are server controls, not stored as ordinary chat text.
    if (text.startsWith('/')) {
      if (!socket.data.admin) {
        recent = recent.filter(t => now - t < 10000); recent.push(now);
        if (recent.length > 6) { timeouts[key()] = now + 30000; return socket.emit('sys', 'Too fast. You are timed out for 30 seconds.'); }
      }
      last = now;
      command(room, socket.data.admin ? 'Admin' : safeName(d && d.name), text);
      return;
    }
    const isPrivateRoom = room.startsWith('private-');
    const payload = d && d.encryptedText;
    let encryptedText = null;
    if (isPrivateRoom) {
      if (text) return socket.emit('sys', 'Text in private rooms must be end-to-end encrypted. Reload the page and try again.');
      if (payload !== undefined && payload !== null) {
        if (!payload || typeof payload.iv !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(payload.iv) ||
            typeof payload.data !== 'string' || payload.data.length < 22 || payload.data.length > 3000 ||
            !/^[A-Za-z0-9_-]+$/.test(payload.data)) {
          return socket.emit('sys', 'Message rejected because the encrypted payload is invalid. Reload the page and try again.');
        }
        encryptedText = { iv: payload.iv, data: payload.data };
      }
    } else if (payload !== undefined && payload !== null) {
      return socket.emit('sys', 'End-to-end encrypted text is only enabled in private rooms. Reload the page and send again.');
    }
    const img = d && typeof d.img === 'string' && imagesAllowed(room) && d.img.length < 1.4e6 && IMG.test(d.img) ? d.img : null;
    if (isPrivateRoom ? (!encryptedText && !img) : (!text && !img)) return;

    if (!socket.data.admin) {
      recent = recent.filter(t => now - t < 10000); recent.push(now);
      if (recent.length > 6) { timeouts[key()] = now + 30000; return socket.emit('sys', 'Too fast. You are timed out for 30 seconds.'); }
    }
    last = now;
    const isAdmin = socket.data.admin === true;
    const message = {
      id: socket.id,
      tok: key(),
      name: isAdmin ? 'Admin' : safeName(d && d.name),
      admin: isAdmin,
      status: isAdmin ? 'Staff' : (USER_STATUSES.includes(d && d.status) ? d.status : 'Online'),
      text: isPrivateRoom ? '' : text,
      t: now
    };
    if (encryptedText) message.encryptedText = encryptedText;
    if (img) {
      message.img = img;
      // Images are visible immediately; this flag tracks visibility, not moderator review.
      message.imageApproved = true;
      message.imageReviewed = isAdmin;
    }
    const replyToMid = Number.isSafeInteger(Number(d && d.replyToMid)) ? Number(d.replyToMid) : 0;
    const replyParent = replyToMid ? (rooms[room] || []).find(item => item.mid === replyToMid) : null;
    if (replyParent && !replyParent.bot) {
      // Store only a reference, not quoted text; this keeps private-room plaintext on clients.
      message.replyTo = { mid: replyParent.mid, name: replyParent.name || 'Anonymous', admin: !!replyParent.admin };
    }
    store(room, message);
    // Deliver ownership hints per recipient; browser tokens remain server-only.
    emitPersonalizedRoomMessage(room, 'msg', message);

    // Moderators may inspect image posts across rooms, including private-* rooms.
    if (img) {
      const adminImage = { mid: message.mid, room, name: message.name, t: message.t, img, admin: isAdmin, pending: false, reviewed: isAdmin };
      for (const [, recipient] of io.sockets.sockets) {
        if (recipient.data.admin) recipient.emit('images:admin:posted', adminImage);
      }
      console.log('[image-moderation] image posted in #' + room + (isAdmin ? ' (admin post)' : ' (visible; awaiting review)'));
    }
  });

  socket.on('message:edit', (d) => {
    const now = Date.now();
    if (blocked() || socket.data.banned || !d || !Number.isSafeInteger(Number(d.mid))) return;
    if (room === 'announcements' || silenced || timeouts[key()] > now) return;
    const mid = Number(d.mid);
    const message = (rooms[room] || []).find(item => item.mid === mid);
    if (!message || message.bot || message.admin || !message.tok || message.tok !== key() || message.img) {
      return socket.emit('sys', 'You can only edit your own text messages.');
    }
    if (now - message.t > 15 * 60 * 1000) {
      return socket.emit('sys', 'Messages can only be edited for 15 minutes after sending.');
    }
    const isPrivateRoom = room.startsWith('private-');
    if (isPrivateRoom) {
      const payload = d.encryptedText;
      if (typeof d.text === 'string' && d.text.length) {
        return socket.emit('sys', 'Private-room edits must stay end-to-end encrypted.');
      }
      if (!payload || typeof payload.iv !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(payload.iv) ||
          typeof payload.data !== 'string' || payload.data.length < 22 || payload.data.length > 3000 ||
          !/^[A-Za-z0-9_-]+$/.test(payload.data)) {
        return socket.emit('sys', 'The encrypted edit was invalid. Reload the page and try again.');
      }
      message.text = '';
      message.encryptedText = { iv: payload.iv, data: payload.data };
    } else {
      if (d.encryptedText !== undefined && d.encryptedText !== null) {
        return socket.emit('sys', 'Encrypted text is only accepted in private rooms.');
      }
      const nextText = clean(d.text, 500);
      if (!nextText || nextText.startsWith('/')) return socket.emit('sys', 'Enter a valid message to edit.');
      message.text = nextText;
    }
    message.edited = true;
    message.editedAt = now;
    emitPersonalizedRoomMessage(room, 'message:edited', message);
    socket.emit('sys', 'Message updated.');
  });

  socket.on('message:delete', (d) => {
    if (blocked() || socket.data.banned || !d || !Number.isSafeInteger(Number(d.mid))) return;
    if (room === 'announcements') return;
    const mid = Number(d.mid);
    const message = (rooms[room] || []).find(item => item.mid === mid);
    if (!message || message.bot || message.admin || !message.tok || message.tok !== key()) {
      return socket.emit('sys', 'You can only delete your own messages.');
    }
    const removed = removeMsg(mid);
    const report = reportLog.get(mid);
    if (report && removed) report.status = 'deleted by author';
    socket.emit('sys', 'Message deleted.');
  });

  socket.on('report', (d) => {
    const now = Date.now();
    if (blocked() || !d || now - lastReport < 1000 || !REASONS[d.reason]) return;
    lastReport = now;
    const k = key();
    reportTimes[k] = (reportTimes[k] || []).filter(t => now - t < 600000);
    if (reportTimes[k].length >= 5) return socket.emit('sys', 'You sent too many reports. Please wait a few minutes.');
    const m = (rooms[room] || []).find(x => x.mid === d.mid);
    // Every regular user's message may be reported, including one's own.
    // Admin/moderator posts are never reportable, even if a client forges a report event.
    if (!m || m.bot || m.admin || m.rep.includes(k)) return;
    reportTimes[k].push(now);
    m.rep.push(k);
    let e = reportLog.get(m.mid);
    if (!e) { e = { mid: m.mid, name: m.name, text: m.encryptedText ? '[end-to-end encrypted text; moderators cannot read it]' : (m.text || '[image]'), tok: m.tok, reasons: [], t: now, status: 'open' }; reportLog.set(m.mid, e); }
    e.reasons.push(d.reason);
    const urgent = d.reason === 'illegal' || d.reason === 'threat';
    const remove = d.reason === 'illegal' || m.rep.length >= REPORT_LIMIT;
    const notifyNow = m.rep.length === 1 || remove || (urgent && !e.urgent);
    if (urgent) e.urgent = true;
    socket.emit('sys', 'Thank you. Your report was sent to the moderators.');
    if (remove) { removeMsg(m.mid); e.status = 'removed'; if (m.tok) strike(m.tok); console.log('[mod] message removed after report'); }
    if (notifyNow) {
      const body = 'Report #' + m.mid + ' (' + e.reasons.length + ' so far): ' + REASONS[d.reason] + '\nAuthor: ' + m.name + '\nMessage: "' + (m.encryptedText ? '[end-to-end encrypted text; moderators cannot read it]' : (m.text || '[image]')).slice(0, 300) + '"\nStatus: ' + (remove ? 'removed' : 'still visible, waiting for your review') +
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

  socket.on('images:admin:list', () => {
    if (!socket.data.admin) return;
    socket.emit('images:admin:list-result', { images: getAdminImageList() });
  });

  socket.on('images:admin:approve', (d) => {
    if (!socket.data.admin || !d || !Number.isSafeInteger(Number(d.mid))) return;
    const found = findStoredMessage(Number(d.mid));
    if (!found || !found.message.img) {
      socket.emit('images:admin:action-result', { ok: false, message: 'That image post is no longer available.' });
      socket.emit('images:admin:list-result', { images: getAdminImageList() });
      return;
    }
    if (found.message.imageReviewed === true) {
      socket.emit('images:admin:action-result', { ok: false, message: 'That image has already been marked as reviewed.' });
      socket.emit('images:admin:list-result', { images: getAdminImageList() });
      return;
    }
    const wasPending = found.message.imageApproved === false;
    found.message.imageApproved = true;
    found.message.imageReviewed = true;
    if (wasPending) io.to(found.room).emit('msg', pub(found.message));
    console.log('[image-moderation] admin reviewed image post #' + found.message.mid + ' in #' + found.room);
    socket.emit('images:admin:action-result', {
      ok: true,
      message: wasPending
        ? 'Image approved and published in #' + found.room + '.'
        : 'Image marked as reviewed in #' + found.room + '.'
    });
    socket.emit('images:admin:list-result', { images: getAdminImageList() });
  });

  socket.on('images:admin:delete', (d) => {
    if (!socket.data.admin || !d || !Number.isSafeInteger(Number(d.mid))) return;
    const found = findStoredMessage(Number(d.mid));
    if (!found || !found.message.img) {
      socket.emit('images:admin:action-result', { ok: false, message: 'That image post is no longer available.' });
      socket.emit('images:admin:list-result', { images: getAdminImageList() });
      return;
    }
    removeMsg(found.message.mid);
    console.log('[image-moderation] admin deleted image post #' + found.message.mid + ' from #' + found.room);
    socket.emit('images:admin:action-result', { ok: true, message: 'Image post deleted from #' + found.room + '.' });
    socket.emit('images:admin:list-result', { images: getAdminImageList() });
  });

  socket.on('images:admin:ban', (d) => {
    if (!socket.data.admin || !d || !Number.isSafeInteger(Number(d.mid))) return;
    const found = findStoredMessage(Number(d.mid));
    if (!found || !found.message.img || found.message.admin || !found.message.tok) {
      socket.emit('images:admin:action-result', { ok: false, message: 'The uploader could not be identified as a regular user.' });
      return;
    }
    const token = found.message.tok;
    const permanent = d.duration === 'permanent';
    const expiresAt = permanent ? 0 : Date.now() + USER_BAN_MS;
    const reason = 'Banned by moderator after an image post';
    userBans.set(token, { expiresAt, reason });
    // Remove every stored image from this browser token when a moderator bans its uploader.
    const uploaderImageIds = Object.values(rooms).flat()
      .filter(message => message.tok === token && message.img)
      .map(message => message.mid);
    for (const imageMid of uploaderImageIds) removeMsg(imageMid);
    let affectedSessions = 0;
    for (const [, recipient] of io.sockets.sockets) {
      if (recipient.data.admin || recipient.data.tok !== token) continue;
      affectedSessions++;
      recipient.data.banned = true;
      recipient.emit('user:banned', { expiresAt, reason });
      recipient.emit('sys', permanent ? 'You have been banned until this server restarts.' : 'You have been banned for 24 hours.');
      for (const joinedRoom of [...recipient.rooms]) {
        if (joinedRoom === recipient.id) continue;
        recipient.leave(joinedRoom);
        io.to(joinedRoom).emit('online', io.sockets.adapter.rooms.get(joinedRoom)?.size || 0);
      }
    }
    console.log('[moderation] user banned ' + (permanent ? 'until restart' : 'for 24 hours') + ' after image post #' + found.message.mid + '; active sessions ' + affectedSessions);
    socket.emit('images:admin:action-result', { ok: true, message: permanent ? 'User banned until the server restarts.' : 'User banned for 24 hours.' });
    socket.emit('images:admin:list-result', { images: getAdminImageList() });
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

  socket.on('disconnect', () => {
    removeVoiceParticipant(socket.id);
    endScreenShare(socket.id);
    console.log('[online] ' + io.engine.clientsCount);
    io.to(room).emit('online', io.sockets.adapter.rooms.get(room)?.size || 0);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Chat running on port ' + PORT + (offline ? ' (offline mode)' : '') + (ADMIN ? '' : ' | warning: ADMIN_PASSWORD is not set')));
