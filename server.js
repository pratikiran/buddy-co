import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3000);
const MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
// 'DEMO_MAP_ID' is Google's public development Map ID. It works out of the box for
// AdvancedMarkerElement but shows no custom styling — swap for your own Map ID later.
const MAP_ID = process.env.GOOGLE_MAPS_MAP_ID || 'DEMO_MAP_ID';

// Which map renders in the browser. Google Maps is the real one; OpenStreetMap +
// Leaflet is a keyless stand-in for testing. 'auto' picks Google when a key exists.
const MAP_PROVIDER = (process.env.MAP_PROVIDER || 'auto').toLowerCase();

function resolveProvider() {
  if (MAP_PROVIDER === 'osm' || MAP_PROVIDER === 'google') return MAP_PROVIDER;
  return MAPS_API_KEY ? 'google' : 'osm';
}

// How long a room survives with nobody connected before it is dropped.
const EMPTY_ROOM_TTL_MS = 30 * 60 * 1000;
// Upper bound on one meetup, so a shared link cannot be used to exhaust memory.
const MAX_PARTICIPANTS_PER_ROOM = 25;

/**
 * rooms: Map<roomId, {
 *   createdAt: number,
 *   emptySince: number | null,
 *   members: Map<memberId, { id, name, lat, lng, accuracy, updatedAt, sharing, socket }>
 * }>
 */
const rooms = new Map();

const ROOM_ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alike chars

function newRoomId() {
  const bytes = crypto.randomBytes(8);
  let id = '';
  for (const b of bytes) id += ROOM_ID_ALPHABET[b % ROOM_ID_ALPHABET.length];
  return `${id.slice(0, 4)}-${id.slice(4)}`;
}

function getOrCreateRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    // emptySince starts at creation, not null: a room born from POST /api/rooms
    // has no members yet, and the sweeper only collects rooms whose emptySince
    // is set. Leaving it null meant a link that was created but never opened
    // stayed in memory forever. The first connection clears it below.
    room = { createdAt: Date.now(), emptySince: Date.now(), members: new Map() };
    rooms.set(roomId, room);
  }
  return room;
}

/** Public view of a room — never leaks the socket handle. */
function serializeRoom(room) {
  return [...room.members.values()].map((m) => ({
    id: m.id,
    name: m.name,
    lat: m.lat,
    lng: m.lng,
    accuracy: m.accuracy,
    updatedAt: m.updatedAt,
    sharing: m.sharing,
    away: m.away,
  }));
}

/**
 * Full roster, sent when the membership itself changes (someone joined or left).
 *
 * The frame deliberately carries no selfId. That one field used to differ per
 * recipient, which forced a separate JSON.stringify for every member and made a
 * broadcast cost O(M²) — 187µs in a full 25-person room. Identical bytes for
 * everyone means one pass for the whole room; the client learns its own id from
 * the 'welcome' frame, which always arrives first.
 */
function broadcastRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  broadcastFrame(room, JSON.stringify({ type: 'state', participants: serializeRoom(room) }));
}

/**
 * One member changed — the common case, roughly once per second per member.
 *
 * Sending only what moved keeps a room at O(M²) bytes/sec instead of the O(M³)
 * a full roster costs: 0.10 MB/s rather than 2.42 MB/s in a full room.
 *
 * Safe because a client can only receive a patch for someone it already knows:
 * every membership change broadcasts a full roster first, and WebSocket delivery
 * is ordered.
 */
function broadcastPatch(roomId, memberId, patch) {
  const room = rooms.get(roomId);
  if (!room) return;
  broadcastFrame(room, JSON.stringify({ type: 'patch', id: memberId, patch }));
}

function broadcastFrame(room, frame) {
  for (const member of room.members.values()) sendFrame(member.socket, frame);
}

function send(socket, payload) {
  sendFrame(socket, JSON.stringify(payload));
}

/** Sends an already-serialized frame, so one JSON pass can feed a whole room. */
function sendFrame(socket, frame) {
  if (socket.readyState === socket.OPEN) {
    socket.send(frame);
  }
}

function sanitizeName(raw) {
  const name = String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, 24);
  return name || 'Guest';
}

/**
 * Coerces a value to a finite number, but only from a real number or a numeric
 * string. Plain Number() would turn null, '', [] and false into 0, which would
 * silently drop a client at Null Island.
 */
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Returns a validated {lat, lng, accuracy} or null. */
function parseCoords(msg) {
  const lat = toNumber(msg.lat);
  const lng = toNumber(msg.lng);
  if (lat === null || lng === null) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  const accuracy = toNumber(msg.accuracy);
  return {
    lat,
    lng,
    accuracy: accuracy !== null && accuracy >= 0 ? Math.min(accuracy, 100000) : null,
  };
}

const app = express();
app.use(express.json());

// The browser needs the Maps key, but we keep it out of the committed HTML so the
// only copy lives in .env.
app.get('/api/config', (req, res) => {
  const provider = resolveProvider();
  res.json({
    provider,
    // Only ship the key when the Google provider is actually in use.
    mapsApiKey: provider === 'google' ? MAPS_API_KEY : '',
    mapId: MAP_ID,
    hasKey: Boolean(MAPS_API_KEY),
  });
});

app.post('/api/rooms', (req, res) => {
  let roomId = newRoomId();
  while (rooms.has(roomId)) roomId = newRoomId();
  getOrCreateRoom(roomId);
  res.json({ roomId, url: `/r/${roomId}` });
});

app.get('/api/rooms/:roomId', (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'room_not_found' });
  res.json({ roomId: req.params.roomId, participants: serializeRoom(room) });
});

app.use(express.static(path.join(__dirname, 'public')));

// Leaflet is served from node_modules rather than a CDN so the test map works
// offline and cannot be broken by a third party.
app.use(
  '/vendor/leaflet',
  express.static(path.join(__dirname, 'node_modules', 'leaflet', 'dist')),
);

app.get('/r/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = url.searchParams.get('room');

  if (!roomId) {
    send(socket, { type: 'error', message: 'Missing room id.' });
    socket.close(1008, 'missing room');
    return;
  }

  const room = getOrCreateRoom(roomId);
  if (room.members.size >= MAX_PARTICIPANTS_PER_ROOM) {
    send(socket, { type: 'error', message: 'This meetup room is full.' });
    socket.close(1008, 'room full');
    return;
  }

  room.emptySince = null;

  const member = {
    id: crypto.randomUUID(),
    name: sanitizeName(url.searchParams.get('name')),
    lat: null,
    lng: null,
    accuracy: null,
    updatedAt: null,
    sharing: false,
    // Set when the client tells us its page was hidden. Distinct from 'sharing':
    // an away member is still in the meetup, we just know their last position is
    // no longer being refreshed.
    away: false,
    socket,
  };
  room.members.set(member.id, member);

  // updatedAt values are stamped with this clock, so the client needs it to
  // measure staleness. Phone clocks drift by minutes; comparing a server
  // timestamp against a device clock would make "last seen" fiction.
  send(socket, { type: 'welcome', selfId: member.id, roomId, serverNow: Date.now() });
  broadcastRoom(roomId);

  socket.isAlive = true;
  socket.on('pong', () => {
    socket.isAlive = true;
  });

  socket.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case 'location': {
        const coords = parseCoords(msg);
        if (!coords) return;
        member.lat = coords.lat;
        member.lng = coords.lng;
        member.accuracy = coords.accuracy;
        member.updatedAt = Date.now();
        member.sharing = true;
        const patch = {
          lat: member.lat,
          lng: member.lng,
          accuracy: member.accuracy,
          updatedAt: member.updatedAt,
          sharing: true,
        };
        // A position proves the page is running, so it also cancels 'away' — but
        // only pay the extra field on the rare update that actually clears it,
        // since this is the once-per-second-per-member hot path.
        if (member.away) {
          member.away = false;
          patch.away = false;
        }
        broadcastPatch(roomId, member.id, patch);
        break;
      }
      case 'stop': {
        member.sharing = false;
        member.lat = null;
        member.lng = null;
        member.accuracy = null;
        member.updatedAt = Date.now();
        broadcastPatch(roomId, member.id, {
          lat: null,
          lng: null,
          accuracy: null,
          updatedAt: member.updatedAt,
          sharing: false,
        });
        break;
      }
      case 'rename': {
        member.name = sanitizeName(msg.name);
        broadcastPatch(roomId, member.id, { name: member.name });
        break;
      }
      // The client sends these from visibilitychange, which fires before the
      // browser freezes the page. It is the only warning we get: the heartbeat
      // cannot see a backgrounded tab, because the browser's network stack
      // answers pings without running any page JS.
      case 'away':
      case 'active': {
        const away = msg.type === 'away';
        if (member.away === away) break; // nothing new to tell the room
        member.away = away;
        broadcastPatch(roomId, member.id, { away });
        break;
      }
      default:
        break;
    }
  });

  socket.on('close', () => {
    room.members.delete(member.id);
    if (room.members.size === 0) room.emptySince = Date.now();
    broadcastRoom(roomId);
  });

  socket.on('error', () => socket.terminate());
});

// Drop dead connections so ghosts do not linger as pins on the map.
const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.isAlive === false) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 30_000);

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    if (room.members.size === 0 && room.emptySince && now - room.emptySince > EMPTY_ROOM_TTL_MS) {
      rooms.delete(roomId);
    }
  }
}, 60_000);

server.on('close', () => {
  clearInterval(heartbeat);
  clearInterval(sweeper);
});

server.listen(PORT, () => {
  const provider = resolveProvider();
  console.log(`\n  Meet Up MVP running at  http://localhost:${PORT}`);

  if (provider === 'google') {
    console.log(`  Map: Google Maps (key …${MAPS_API_KEY.slice(-6)}, Map ID ${MAP_ID})`);
    if (!MAPS_API_KEY) {
      console.log('  ⚠  MAP_PROVIDER=google but GOOGLE_MAPS_API_KEY is empty — the map');
      console.log('     will not render. See SETUP-GOOGLE-CLOUD.md.');
    }
  } else {
    console.log('  Map: OpenStreetMap + Leaflet (test provider, no API key needed)');
    if (!MAPS_API_KEY) {
      console.log('     Add GOOGLE_MAPS_API_KEY to .env to switch to Google Maps.');
    } else {
      console.log('     MAP_PROVIDER=osm is overriding your Google key.');
    }
  }
  console.log('');
});

// Stopping cleanly matters here: without a close frame the browser sees a TCP
// reset, and every pin on every open map freezes until the client's backoff
// reconnect catches up. Closing the sockets ourselves makes that a blip.
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return; // a second Ctrl-C should not re-enter this
  shuttingDown = true;
  console.log(`\n  ${signal} — closing ${wss.clients.size} connection(s)…`);

  // 1001 'going away' is the code a browser expects from a server that is
  // stopping; app.js treats any close as its cue to reconnect with backoff.
  for (const socket of wss.clients) socket.close(1001, 'server shutting down');
  wss.close();

  // Idle keep-alive sockets would otherwise hold server.close() open until the
  // keep-alive timeout expires.
  server.closeIdleConnections?.();
  server.close(() => process.exit(0)); // 'close' also clears the intervals above

  // A socket that refuses to finish must not push us past Docker's 10s grace
  // period, where SIGKILL would undo the graceful part entirely.
  setTimeout(() => {
    for (const socket of wss.clients) socket.terminate();
    process.exit(0);
  }, 5_000).unref();
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => shutdown(signal));
}
