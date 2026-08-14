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
  nameDialog: document.getElementById('name-dialog'),
  nameForm: document.getElementById('name-form'),
  nameTitle: document.getElementById('name-dialog-title'),
  nameSub: document.getElementById('name-dialog-sub'),
  nameInput: document.getElementById('name-input'),
  nameError: document.getElementById('name-error'),
  nameSubmit: document.getElementById('name-submit'),
  nameCancel: document.getElementById('name-cancel'),
};

el.roomCode.textContent = roomId;

const state = {
  name: '', // what this browser publishes as; empty until the user has said
  joined: false, // true once we have a name and a socket has been opened
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
  previewCoords: null, // our own position, shown locally but not published
  clockSkew: 0, // serverNow - Date.now(), measured once from the welcome frame
};

// How long without an update before a pin stops counting as live. Comfortably
// more than two missed keepalives, so a single dropped fix is not enough.
const STALE_AFTER_MS = 45000;
// watchPosition can go quiet when you stand still, which would decay a perfectly
// healthy pin into "no signal". Re-publishing the last fix on this interval keeps
// updatedAt honest and turns its absence into a real signal.
const POSITION_KEEPALIVE_MS = 20000;

/**
 * updatedAt is stamped by the server, so ages have to be measured against the
 * server's clock. Device clocks are routinely minutes off, which would otherwise
 * show "last seen 4m ago" for a pin that arrived a second ago — or, worse, mark
 * a live friend stale.
 */
function serverNow() {
  return Date.now() + state.clockSkew;
}

function isStale(participant) {
  if (!participant.updatedAt) return false;
  return serverNow() - participant.updatedAt > STALE_AFTER_MS;
}

/**
 * Two routes to the same conclusion — this position is last-known, not live.
 * 'away' is the explicit heads-up from a page that was being hidden; staleness
 * is the fallback for every case where that message never made it out.
 */
function isPaused(participant) {
  return Boolean(participant.away) || isStale(participant);
}

// Marker id for the local-only preview pin. Prefixed so it can never collide
// with a server-assigned participant id.
const PREVIEW_ID = '__preview__';

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
    const stale = isPaused(participant);
    state.map.upsertMarker(participant.id, {
      position: { lat: participant.lat, lng: participant.lng },
      name: participant.name,
      color,
      isSelf,
      stale,
      accuracy: participant.accuracy,
      // Only a state flip rebuilds the pin DOM — deliberately not the age, which
      // changes every second and would rebuild every marker with it.
      signature: `${isSelf ? 'You' : participant.name}|${color}|${stale ? 'stale' : 'live'}`,
    });
    state.renderedIds.add(participant.id);
  }

  // Our real pin supersedes the local-only preview of the same position.
  if (located.some((p) => p.id === state.selfId)) clearPreview();

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
  const seconds = Math.round((serverNow() - timestamp) / 1000);
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
    const paused = participant.sharing && participant.lat !== null && isPaused(participant);
    const li = document.createElement('li');
    li.className = 'person' + (isSelf ? ' is-self' : '') + (paused ? ' is-paused' : '');

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
      // Saying "last seen" rather than "updated" is the whole point: the number
      // is the same, but one implies the pin is current and the other does not.
      if (participant.away) {
        bits.push(`paused · last seen ${formatAgo(participant.updatedAt)}`);
      } else if (isStale(participant)) {
        bits.push(`no signal · last seen ${formatAgo(participant.updatedAt)}`);
      } else {
        bits.push(`updated ${formatAgo(participant.updatedAt)}`);
      }
      meta.textContent = bits.join(' · ');
    }

    text.append(name, meta);
    li.append(swatch, text);

    if (isSelf) {
      const rename = document.createElement('button');
      rename.className = 'link-button';
      rename.textContent = 'Rename';
      rename.addEventListener('click', () => openNameDialog('edit'));
      li.append(rename);
    }

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

// Keeps the "updated 12s ago" strings honest without any server chatter. This
// drives the map too, not just the roster: a pin crossing STALE_AFTER_MS is a
// change nobody sends us, so without a tick it would stay coloured until the
// next unrelated message happened to arrive.
setInterval(renderAll, 10000);

// ------------------------------------------------------------------ Identity

const NAME_KEY = 'meetup:name';
const MAX_NAME_LENGTH = 24; // matches sanitizeName() on the server

/**
 * The name this browser has used before. localStorage is the durable copy, so a
 * shared link opened next week already knows who you are; sessionStorage wins
 * when present so two tabs on one machine can be two different people.
 */
function storedName() {
  const stored = sessionStorage.getItem(NAME_KEY) || localStorage.getItem(NAME_KEY) || '';
  return stored.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME_LENGTH);
}

function rememberName(name) {
  localStorage.setItem(NAME_KEY, name); // remembered for next time
  sessionStorage.setItem(NAME_KEY, name); // this tab's identity
}

/**
 * @param {'join'|'edit'} mode - 'join' is the blocking gate on first arrival;
 *   'edit' is the optional rename once you are already in the room.
 */
function openNameDialog(mode) {
  const joining = mode === 'join';

  el.nameTitle.textContent = joining ? 'Who’s joining?' : 'Change your name';
  el.nameSub.textContent = joining
    ? 'Your friends in this meetup will see this name on your pin.'
    : 'Everyone in this meetup sees the new name straight away.';
  el.nameSubmit.textContent = joining ? 'Join meetup' : 'Save';
  el.nameCancel.hidden = joining; // there is nothing to fall back to yet
  el.nameError.hidden = true;
  el.nameInput.value = state.name || storedName();

  if (!el.nameDialog.open) el.nameDialog.showModal();
  el.nameInput.focus();
  el.nameInput.select();
}

// Escape must not dismiss the join gate — there is no room behind it to return
// to. Two belts: cancel the close request, and, because Chrome ignores that
// until the page has user activation, put the dialog straight back if it does
// slip through. state.name is only set once a name has actually been accepted.
el.nameDialog.addEventListener('cancel', (event) => {
  if (!state.name) event.preventDefault();
});

el.nameDialog.addEventListener('close', () => {
  if (!state.name) openNameDialog('join');
});

el.nameCancel.addEventListener('click', () => el.nameDialog.close());

el.nameForm.addEventListener('submit', (event) => {
  event.preventDefault();

  const name = el.nameInput.value.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME_LENGTH);
  if (!name) {
    el.nameError.textContent = 'Please enter a name so your friends know which pin is yours.';
    el.nameError.hidden = false;
    el.nameInput.focus();
    return;
  }

  const previous = state.name;
  state.name = name;
  rememberName(name);
  el.nameDialog.close();

  if (!state.joined) {
    joinRoom();
  } else if (name !== previous) {
    // A reconnect would carry the new name in its query string anyway; this
    // updates the live session without waiting for one.
    if (state.socket?.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify({ type: 'rename', name }));
    }
    toast(`You’re now “${name}” in this meetup.`);
  }
});

/**
 * Whether this tab was sharing in this room when it was last alive.
 *
 * sessionStorage, keyed by room, is the exact privacy boundary we want: iOS
 * discarding a backgrounded tab and reloading it should pick sharing back up,
 * because the user opted in and never opted out — but deliberately closing the
 * tab ends the session, and the flag dies with it.
 */
const SHARING_KEY = `meetup:sharing:${roomId}`;

function rememberSharing(on) {
  if (on) sessionStorage.setItem(SHARING_KEY, '1');
  else sessionStorage.removeItem(SHARING_KEY);
}

/** Everything that must wait until we know who the user is. */
function joinRoom() {
  state.joined = true;
  el.shareToggle.disabled = false;
  connect();

  // A reload we did not ask for should not silently demote us to a stale pin
  // that no longer moves. Note this only ever restarts what this same tab was
  // already doing in this same room.
  if (sessionStorage.getItem(SHARING_KEY)) {
    startSharing({ resumed: true });
    return; // startSharing owns the pin; no local-only preview needed
  }

  // Asked only now so the browser's location prompt does not compete with the
  // name dialog for the user's attention.
  previewLocation();
}

// ----------------------------------------------------------------- WebSocket

function connect() {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${scheme}://${location.host}/ws?room=${encodeURIComponent(roomId)}&name=${encodeURIComponent(state.name)}`;

  const socket = new WebSocket(url);
  state.socket = socket;
  el.status.textContent = 'Connecting…';

  socket.addEventListener('open', () => {
    state.reconnectDelay = 1000;
    el.status.textContent = 'Connected';
    el.status.classList.remove('bad');
    // A reconnect must re-publish our last known position.
    if (state.sharing && state.lastCoords) sendLocation(state.lastCoords);
    // The server gave this connection a fresh member with away=false. If we are
    // reconnecting while still hidden, say so rather than looking live.
    if (document.hidden) sendSignal('away');
  });

  socket.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === 'welcome') {
      // Our id arrives here and only here — 'state' no longer carries it, so
      // that one frame can be shared byte-for-byte with the whole room.
      state.selfId = msg.selfId;
      // One sample is plenty: the network latency it folds in is milliseconds
      // against a 45-second threshold, and clocks do not drift within a meetup.
      if (typeof msg.serverNow === 'number') state.clockSkew = msg.serverNow - Date.now();
    } else if (msg.type === 'state') {
      // Full roster: sent on join and on leave, i.e. whenever membership moves.
      state.participants = msg.participants;
      const others = state.participants.length - 1;
      el.status.textContent =
        others <= 0 ? 'Connected · waiting for friends' : `Connected · ${others + 1} here`;
      renderAll();
    } else if (msg.type === 'patch') {
      // One participant changed. Membership is unchanged, so the status line
      // and the roster length stay as they are.
      const participant = state.participants.find((p) => p.id === msg.id);
      // An id we do not know can only mean we are mid-resync; the full 'state'
      // that accompanies every membership change will bring us back in line.
      if (!participant) return;
      Object.assign(participant, msg.patch);
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

function sendSignal(type) {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({ type }));
  }
}

// --------------------------------------------------------------- Page lifecycle

/**
 * The one moment we can still tell the room anything.
 *
 * Backgrounding a tab does not close the socket — the browser's network stack
 * keeps answering the server's pings without running any page JS — so from the
 * server's side nothing happens at all. Meanwhile watchPosition stops firing,
 * because no browser grants a web page background location. Left alone that
 * combination parks a confident-looking pin at a position the person left ten
 * minutes ago. visibilitychange fires before the freeze, so we get one chance.
 */
document.addEventListener('visibilitychange', () => {
  if (!state.joined) return;

  if (document.hidden) {
    sendSignal('away');
    return;
  }

  sendSignal('active');
  // watchPosition can take a while to produce its first fix after a resume, so
  // ask for one directly instead of leaving a stale pin up in the meantime.
  if (state.sharing) refreshPositionNow();
});

/** A one-shot fix used to catch up immediately after the page comes back. */
function refreshPositionNow() {
  if (!('geolocation' in navigator) || !window.isSecureContext) return;

  navigator.geolocation.getCurrentPosition(
    (position) => {
      if (!state.sharing) return; // sharing was turned off while we waited
      state.lastCoords = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy,
      };
      sendLocation(state.lastCoords);
    },
    () => {}, // the running watch will catch up on its own
    { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
  );
}

/**
 * Standing still can stop watchPosition from firing, which would let a healthy
 * pin decay into "no signal". Re-sending the last fix keeps updatedAt truthful,
 * and — because a frozen page cannot run this timer — makes a missing keepalive
 * genuine evidence that the browser stopped running.
 */
setInterval(() => {
  if (!state.sharing || !state.lastCoords) return;
  if (document.hidden) return; // a hidden tab must look paused, not live
  sendLocation(state.lastCoords);
}, POSITION_KEEPALIVE_MS);

// ----------------------------------------------------- Local location preview

/**
 * Puts the map where the user actually is the moment the room opens, so it
 * never starts as a blank world view. This is a single read, kept entirely in
 * this browser — nothing reaches the server until "Send my location" is pressed.
 */
function previewLocation() {
  if (!('geolocation' in navigator) || !window.isSecureContext) return;

  navigator.geolocation.getCurrentPosition(
    (position) => {
      if (state.sharing) return; // real sharing started first; it owns the pin
      state.previewCoords = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy,
      };
      renderPreview();
    },
    // Denied or unavailable is not an error here: the user never asked for
    // this, so stay quiet and leave the world view in place.
    () => {},
    // A cached, coarse fix is fine — this is only about framing the map.
    { enableHighAccuracy: false, maximumAge: 300000, timeout: 10000 },
  );
}

function renderPreview() {
  if (!state.map || !state.previewCoords) return;

  const { lat, lng, accuracy } = state.previewCoords;
  state.map.upsertMarker(PREVIEW_ID, {
    position: { lat, lng },
    name: 'You',
    color: SELF_COLOR,
    isSelf: true,
    muted: true,
    accuracy,
    signature: 'preview',
  });

  // Only claim the viewport while it is still the default world view — never
  // fight an auto-fit over real participants or a pan the user made.
  if (!state.userMovedMap && !state.hasAutoFitted) state.map.setCenter({ lat, lng }, 15);
}

function clearPreview() {
  if (!state.previewCoords) return;
  state.previewCoords = null;
  state.map?.removeMarker(PREVIEW_ID);
}

// --------------------------------------------------------------- Geolocation

function startSharing({ highAccuracy = true, resumed = false } = {}) {
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
        rememberSharing(true);
        clearPreview(); // the shared pin takes over from here
        el.shareToggle.disabled = false;
        el.shareToggle.textContent = 'Stop sharing';
        el.shareToggle.classList.add('danger');
        toast(
          resumed
            ? 'Resumed sharing your location after the page reloaded.'
            : 'Your pin is live. Anyone with the link can see it.',
        );
      }
      sendLocation(coords);
    },
    (error) => {
      stopSharing({ silent: true });

      // POSITION_UNAVAILABLE from a high-accuracy request often just means the
      // precise backend (GPS / CoreLocation) had nothing to give; the coarse
      // network fix frequently still resolves, so try that once before giving up.
      if (error.code === 2 && highAccuracy) {
        startSharing({ highAccuracy: false });
        return;
      }

      const messages = {
        1: 'You denied location access. Allow it in the browser’s address-bar icon, then try again.',
        2: 'Your device could not produce a position — this is the operating system, not the app. On macOS check System Settings → Privacy & Security → Location Services: the switch must be on and your browser ticked in the list. Then quit the browser fully and reopen this page.',
        3: 'Timed out getting your location. Try again, ideally near a window or on Wi-Fi.',
      };
      showGeoError(messages[error.code] || error.message);
    },
    { enableHighAccuracy: highAccuracy, maximumAge: 5000, timeout: 20000 },
  );
}

function stopSharing({ silent = false } = {}) {
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }
  // Keep showing yourself locally once you stop publishing, so the map does not
  // jump back to a view with nothing on it.
  if (state.lastCoords) {
    state.previewCoords = state.lastCoords;
    renderPreview();
  }
  state.sharing = false;
  rememberSharing(false); // an explicit stop must not come back on reload
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

renderPeople();

// Nobody joins as an anonymous "Guest": either this browser already knows the
// name from a previous visit, or we ask for one before touching the room.
state.name = storedName();
if (state.name) {
  joinRoom();
} else {
  el.status.textContent = 'Enter your name to join';
  openNameDialog('join');
}

initMap()
  .then(() => {
    renderAll();
    renderPreview();
  })
  .catch((err) => showMapFallback(err.message));
