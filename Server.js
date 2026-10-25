const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5 });
app.use(express.static('public'));

const MAX_MSGS = 50;          // per kamer
const TTL = 60 * 60 * 1000;   // berichten verdwijnen na 1 uur
const rooms = {};             // enkel in het geheugen: niets op schijf, geen IP's

const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);
const roomName = (s) => clean(s, 30).toLowerCase().replace(/[^a-z0-9-_]/g, '') || 'algemeen';

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

  socket.on('msg', (data) => {
    const now = Date.now();
    if (now - last < 500) return;           // max 2 berichten per seconde
    const text = clean(data && data.text, 500);
    if (!text) return;
    last = now;
    const m = { name: clean(data.name, 20) || 'Anoniem', text, t: now };
    (rooms[room] ||= []).push(m);
    if (rooms[room].length > MAX_MSGS) rooms[room].shift();
    io.to(room).emit('msg', m);
  });

  socket.on('disconnect', () => {
    io.to(room).emit('online', io.sockets.adapter.rooms.get(room)?.size || 0);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Chat draait op poort ' + PORT));
