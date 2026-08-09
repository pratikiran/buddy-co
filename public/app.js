// Meet Up — room page controller.
// Responsibilities: load Google Maps, hold a WebSocket to the room, publish this
// browser's geolocation when the user opts in, and render every participant as a pin.

const roomId = decodeURIComponent(location.pathname.replace(/^\/r\//, ''));

const el = {
  status: document.getElementById('status'),
  roomCode: document.getElementById('room-code'),
  shareToggle: document.getElementById('share-toggle'),
  shareLink: document.getElementById('share'),
  geoError: document.getElementById('geo-error'),
  people: document.getElementById('people'),
  toast: document.getElementById('toast'),
  mapFallback: document.getElementById('map-fallback'),
  mapFallbackDetail: document.getElementById('map-fallback-detail'),
  panelGrip: document.getElementById('panel-grip'),
  providerBadge: document.getElementById('provider-badge'),
};

el.roomCode.textContent = roomId;

const state = {
  selfId: null,
  participants: [],
  sharing: false,
  watchId: null,
  socket: null,
  reconnectDelay: 1000,
  map: null, // provider adapter, see map-google.js / map-osm.js
  renderedIds: new Set(), // participant ids currently drawn on the map
  hasAutoFitted: false,
  userMovedMap: false,
};

// Distinct colors so each pin is tellable apart at a glance. Index 0 is reserved
// for "you".
const SELF_COLOR = '#2563eb';
const PEER_COLORS = ['#e11d48', '#059669', '#d97706', '#7c3aed', '#0891b2', '#be185d'];

function colorFor(participant) {
  if (participant.id === state.selfId) return SELF_COLOR;
  const peers = state.participants.filter((p) => p.id !== state.selfId);
  const idx = peers.findIndex((p) => p.id === participant.id);
  return PEER_COLORS[(idx < 0 ? 0 : idx) % PEER_COLORS.length];
}

function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.toast.hidden = true;
  }, 2600);
}

// ------------------------------------------------------------------ Map setup

/**
 * The server decides which provider to use; both adapters expose the same
 * interface, so everything below this function is provider-agnostic.
 */
async function initMap() {
  const config = await (await fetch('/api/config')).json();

  if (config.provider === 'google' && !config.hasKey) {
    throw new Error(
      'No Google Maps API key is configured. Add GOOGLE_MAPS_API_KEY to .env (see SETUP-GOOGLE-CLOUD.md), or set MAP_PROVIDER=osm to test on OpenStreetMap without a key.',
    );
  }

  const adapter =
    config.provider === 'osm' ? await import('./map-osm.js') : await import('./map-google.js');

  state.map = await adapter.createMap(document.getElementById('map'), config);

  // Once the user pans deliberately, stop yanking the viewport around.
  state.map.addUserPanListener(() => {
    state.userMovedMap = true;
  });

  if (adapter.isTestProvider) {
    el.providerBadge.textContent = adapter.label;
    el.providerBadge.hidden = false;
  }
}

function showMapFallback(detail) {
  el.mapFallbackDetail.textContent = detail;
  el.mapFallback.hidden = false;
  document.getElementById('map').style.display = 'none';
}

function renderMarkers() {
  if (!state.map) return;

  const located = state.participants.filter(
    (p) => p.sharing && typeof p.lat === 'number' && typeof p.lng === 'number',
  );
  const liveIds = new Set(located.map((p) => p.id));

  // Remove pins for people who left or stopped sharing.
  for (const id of state.renderedIds) {
    if (!liveIds.has(id)) {
      state.map.removeMarker(id);
      state.renderedIds.delete(id);
    }
  }

  for (const participant of located) {
    const isSelf = participant.id === state.selfId;
    const color = colorFor(participant);
    state.map.upsertMarker(participant.id, {
      position: { lat: participant.lat, lng: participant.lng },
      name: participant.name,
      color,
      isSelf,
      accuracy: participant.accuracy,
      signature: `${isSelf ? 'You' : participant.name}|${color}`,
    });
    state.renderedIds.add(participant.id);
  }

  fitViewport(located);
}

function fitViewport(located) {
  if (located.length === 0 || state.userMovedMap) return;

  if (located.length === 1) {
    if (!state.hasAutoFitted) {
      state.map.setCenter({ lat: located[0].lat, lng: located[0].lng }, 15);
      state.hasAutoFitted = true;
    }
    return;
  }

  state.map.fitBounds(
    located.map((p) => ({ lat: p.lat, lng: p.lng })),
    { top: 90, right: 60, bottom: 260, left: 60 },
  );
  state.hasAutoFitted = true;
}

// ------------------------------------------------------------------ Distances

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function formatDistance(meters) {
  if (meters < 1000) return `${Math.round(meters)} m away`;
  if (meters < 10000) return `${(meters / 1000).toFixed(1)} km away`;
  return `${Math.round(meters / 1000)} km away`;
}

function formatAgo(timestamp) {
  if (!timestamp) return '';
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

// ------------------------------------------------------------------ Roster UI

function renderPeople() {
  const self = state.participants.find((p) => p.id === state.selfId);
  el.people.innerHTML = '';

  for (const participant of state.participants) {
    const isSelf = participant.id === state.selfId;
    const li = document.createElement('li');
    li.className = 'person' + (isSelf ? ' is-self' : '');

    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = colorFor(participant);

    const text = document.createElement('div');
    text.className = 'person-text';

    const name = document.createElement('div');
    name.className = 'person-name';
    name.textContent = isSelf ? `${participant.name} (you)` : participant.name;

    const meta = document.createElement('div');
    meta.className = 'person-meta';

    if (!participant.sharing || participant.lat === null) {
      meta.textContent = 'Location not shared yet';
    } else {
      const bits = [];
      if (!isSelf && self?.sharing && self.lat !== null) {
        bits.push(formatDistance(haversineMeters(self, participant)));
      }
      bits.push(`updated ${formatAgo(participant.updatedAt)}`);
      meta.textContent = bits.join(' · ');
    }

    text.append(name, meta);
    li.append(swatch, text);

    if (participant.sharing && participant.lat !== null) {
      const focus = document.createElement('button');
      focus.className = 'link-button';
      focus.textContent = 'Center';
      focus.addEventListener('click', () => {
        state.userMovedMap = true; // an explicit choice by the user
        state.map?.focusOn(
          { lat: participant.lat, lng: participant.lng },
          Math.max(state.map.getZoom(), 15),
        );
      });
      li.append(focus);
    }

    el.people.append(li);
  }

  // Nudge shown below your own row, so the roster still reads top-down.
  if (state.participants.length <= 1) {
    const li = document.createElement('li');
    li.className = 'person empty';
    li.textContent = 'Nobody else here yet — tap “Share link”.';
    el.people.append(li);
  }
}

function renderAll() {
  renderMarkers();
  renderPeople();
}

// Keeps the "updated 12s ago" strings honest without any server chatter.
setInterval(renderPeople, 10000);

// ----------------------------------------------------------------- WebSocket

function connect() {
  const name = sessionStorage.getItem('meetup:name') || localStorage.getItem('meetup:name') || 'Guest';
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${scheme}://${location.host}/ws?room=${encodeURIComponent(roomId)}&name=${encodeURIComponent(name)}`;

  const socket = new WebSocket(url);
  state.socket = socket;
  el.status.textContent = 'Connecting…';

  socket.addEventListener('open', () => {
    state.reconnectDelay = 1000;
    el.status.textContent = 'Connected';
    el.status.classList.remove('bad');
    // A reconnect must re-publish our last known position.
    if (state.sharing && state.lastCoords) sendLocation(state.lastCoords);
  });

  socket.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === 'welcome') {
      state.selfId = msg.selfId;
    } else if (msg.type === 'state') {
      state.selfId = msg.selfId ?? state.selfId;
      state.participants = msg.participants;
      const others = state.participants.length - 1;
      el.status.textContent =
        others <= 0 ? 'Connected · waiting for friends' : `Connected · ${others + 1} here`;
      renderAll();
    } else if (msg.type === 'error') {
      el.status.textContent = msg.message;
      el.status.classList.add('bad');
    }
  });

  socket.addEventListener('close', () => {
    el.status.textContent = 'Reconnecting…';
    el.status.classList.add('bad');
    setTimeout(connect, state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, 15000);
  });
}

function sendLocation({ lat, lng, accuracy }) {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({ type: 'location', lat, lng, accuracy }));
  }
}

// --------------------------------------------------------------- Geolocation

function startSharing() {
  el.geoError.hidden = true;

  if (!('geolocation' in navigator)) {
    return showGeoError('This browser does not support location sharing.');
  }
  if (!window.isSecureContext) {
    return showGeoError(
      'Browsers only give out location over HTTPS or on localhost. Open this page at http://localhost:3000 instead of an IP address.',
    );
  }

  el.shareToggle.disabled = true;
  el.shareToggle.textContent = 'Getting your location…';

  state.watchId = navigator.geolocation.watchPosition(
    (position) => {
      const coords = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy,
      };
      state.lastCoords = coords;
      if (!state.sharing) {
        state.sharing = true;
        el.shareToggle.disabled = false;
        el.shareToggle.textContent = 'Stop sharing';
        el.shareToggle.classList.add('danger');
        toast('Your pin is live. Anyone with the link can see it.');
      }
      sendLocation(coords);
    },
    (error) => {
      stopSharing({ silent: true });
      const messages = {
        1: 'You denied location access. Allow it in the browser’s address-bar icon, then try again.',
        2: 'Your position is unavailable right now. Check that location services are on for your device.',
        3: 'Timed out getting your location. Try again, ideally near a window or on Wi-Fi.',
      };
      showGeoError(messages[error.code] || error.message);
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
  );
}

function stopSharing({ silent = false } = {}) {
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }
  state.sharing = false;
  state.lastCoords = null;
  el.shareToggle.disabled = false;
  el.shareToggle.textContent = 'Send my location';
  el.shareToggle.classList.remove('danger');
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({ type: 'stop' }));
  }
  if (!silent) toast('You stopped sharing your location.');
}

function showGeoError(message) {
  el.geoError.textContent = message;
  el.geoError.hidden = false;
  el.shareToggle.disabled = false;
  el.shareToggle.textContent = 'Send my location';
  el.shareToggle.classList.remove('danger');
}

el.shareToggle.addEventListener('click', () => {
  if (state.sharing) stopSharing();
  else startSharing();
});

// -------------------------------------------------------------------- Share

el.shareLink.addEventListener('click', async () => {
  const url = location.href;
  const shareData = { title: 'Meet Up', text: 'Join my meetup and share your location:', url };

  if (navigator.share && navigator.canShare?.(shareData)) {
    try {
      await navigator.share(shareData);
      return;
    } catch {
      // User dismissed the sheet — fall through to clipboard.
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied. Send it to your friends.');
  } catch {
    window.prompt('Copy this link and send it to your friends:', url);
  }
});

el.panelGrip.addEventListener('click', () => document.body.classList.toggle('panel-collapsed'));
el.panelGrip.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    document.body.classList.toggle('panel-collapsed');
  }
});

window.addEventListener('beforeunload', () => {
  if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
});

// ------------------------------------------------------------------ Bootstrap

connect();
renderPeople();

initMap()
  .then(renderAll)
  .catch((err) => showMapFallback(err.message));
