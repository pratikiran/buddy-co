// Meet Up — room page controller.
// Responsibilities: load the map, hold a WebSocket to the room, publish this
// browser's geolocation when the user opts in, and render every participant as a
// pin. Motion is part of the contract here: a position never appears, it arrives.

const roomId = decodeURIComponent(location.pathname.replace(/^\/r\//, ''));

const el = {
  status: document.getElementById('status'),
  statusChip: document.getElementById('status-chip'),
  roomCode: document.getElementById('room-code'),
  countBadge: document.getElementById('count-badge'),
  crewCount: document.getElementById('crew-count'),
  shareToggle: document.getElementById('share-toggle'),
  shareLink: document.getElementById('share'),
  geoError: document.getElementById('geo-error'),
  people: document.getElementById('people'),
  toast: document.getElementById('toast'),
  mapFallback: document.getElementById('map-fallback'),
  mapFallbackDetail: document.getElementById('map-fallback-detail'),
  panelGrip: document.getElementById('panel-grip'),
  panel: document.querySelector('.panel'),
  mapControls: document.getElementById('map-controls'),
  frameAll: document.getElementById('frame-all'),
  centerMe: document.getElementById('center-me'),
  providerBadge: document.getElementById('provider-badge'),
  locator: document.getElementById('locator'),
  locatorText: document.getElementById('locator-text'),
  nameDialog: document.getElementById('name-dialog'),
  nameForm: document.getElementById('name-form'),
  nameTitle: document.getElementById('name-dialog-title'),
  nameSub: document.getElementById('name-dialog-sub'),
  nameInput: document.getElementById('name-input'),
  nameError: document.getElementById('name-error'),
  nameSubmit: document.getElementById('name-submit'),
  nameCancel: document.getElementById('name-cancel'),
  guideButton: document.getElementById('guide'),
  guideDialog: document.getElementById('guide-dialog'),
  guideTitle: document.getElementById('guide-title'),
  guideLede: document.getElementById('guide-lede'),
  guideClose: document.getElementById('guide-close'),
  guideDone: document.getElementById('guide-done'),
};

el.roomCode.textContent = roomId;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

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
  renderedIds: new Set(), // anchor ids currently drawn on the map
  groupSizes: new Map(), // anchor id -> how many people that pin covered last render
  seenIds: new Set(), // ids whose roster row has already played its entrance
  announced: new Set(), // ids we have already toasted an arrival for
  hasAutoFitted: false,
  userMovedMap: false,
  followSelf: false, // keep the map centred on your own pin as it moves
  cameraBusyUntil: 0, // when the current map move will have settled
  previewCoords: null, // our own position, shown locally but not published
  previewPending: false, // a position request is already in flight
  clockSkew: 0, // serverNow - Date.now(), measured once from the welcome frame
  burstUntil: 0, // while in the future, our pin plays the go-live broadcast
};

// How long without an update before a pin stops counting as live. Comfortably
// more than two missed keepalives, so a single dropped fix is not enough.
const STALE_AFTER_MS = 45000;
// watchPosition can go quiet when you stand still, which would decay a perfectly
// healthy pin into "no signal". Re-publishing the last fix on this interval keeps
// updatedAt honest and turns its absence into a real signal.
const POSITION_KEEPALIVE_MS = 20000;
// How long the go-live rings keep leaving your pin. Matches two full runs of the
// `burst` keyframes plus the second ring's offset, so no ring is cut mid-flight.
const BURST_MS = 3200;
// How long the camera takes to reach a new frame. An arriving pin waits this out
// before emerging, so it comes out of a place you are already looking at rather
// than somewhere the map is still travelling towards.
const FLY_MS = 950;
const FIT_MS = 550;
// Closer than this and two people are, for map purposes, in the same place:
// their pins would overlap into an unreadable stack, so they become one pin.
// Roughly the width of a café — and comfortably inside typical GPS error, so
// drawing them apart would be claiming precision the fix does not have.
const CLUSTER_RADIUS_M = 10;
// Whether asking for a position is even possible here. Browsers only hand out
// location over HTTPS or on localhost.
const CAN_LOCATE = 'geolocation' in navigator && window.isSecureContext;

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

// Lime is reserved for you — it is the accent the whole interface is built on,
// so your own pin is the one thing that matches the chrome. Everyone else gets a
// luminous pastel from the same family, distinct at a glance on black.
const SELF_COLOR = '#d9ef92';
const PEER_COLORS = ['#8fd4ff', '#c9a8ff', '#ffc978', '#7fe3b0', '#ff9bb0', '#8ff0e6'];
// A group of other people has no single identity colour, so it takes none. The
// faces inside the label still carry each person's own colour.
const GROUP_COLOR = '#ffffff';

function colorFor(participant) {
  if (participant.id === state.selfId) return SELF_COLOR;
  const peers = state.participants.filter((p) => p.id !== state.selfId);
  const idx = peers.findIndex((p) => p.id === participant.id);
  return PEER_COLORS[(idx < 0 ? 0 : idx) % PEER_COLORS.length];
}

function toast(message) {
  el.toast.textContent = message;
  el.toast.classList.add('is-visible');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.toast.classList.remove('is-visible'), 3200);
}

/** The light band that crosses a button, so a press reads as fired. */
function sweep(button) {
  button.classList.remove('is-sweeping');
  void button.offsetWidth; // restart the animation on a repeat press
  button.classList.add('is-sweeping');
}

// -------------------------------------------------------------- The locator

/**
 * The waiting state, drawn as the route a pin is about to take: an S-curve that
 * draws itself with a spark running the line and a scan pulsing at the far end.
 * It is on screen for exactly as long as there is no pin to look at.
 */
function showLocator(message) {
  el.locatorText.textContent = message;
  el.locator.classList.remove('is-leaving');
  el.locator.hidden = false;
  clearTimeout(showLocator._t);
}

function hideLocator() {
  if (el.locator.hidden) return;
  el.locator.classList.add('is-leaving');
  clearTimeout(showLocator._t);
  showLocator._t = setTimeout(() => {
    el.locator.hidden = true;
    el.locator.classList.remove('is-leaving');
  }, 480);
}

/**
 * One ring leaving your pin at map scale, fired the instant the room starts
 * receiving your position. The pin's own rings say "this is live"; this says
 * "it just happened", which is a different sentence.
 */
function shockwave(position) {
  if (reducedMotion.matches) return;
  const point = state.map?.toPixel?.(position);
  if (!point) return;

  for (const n of [1, 2]) {
    const ring = document.createElement('div');
    ring.className = n === 2 ? 'shockwave shockwave-2' : 'shockwave';
    ring.style.left = `${point.x}px`;
    ring.style.top = `${point.y}px`;
    document.body.append(ring);
    // animationend is the normal exit; the timer is the backstop for a tab that
    // is hidden mid-animation and never fires one.
    ring.addEventListener('animationend', () => ring.remove());
    setTimeout(() => ring.remove(), 2000);
  }
}

/** The whole go-live moment: rings off the pin, a wave across the map, a word. */
function celebrateGoLive(coords) {
  state.burstUntil = Date.now() + BURST_MS;
  shockwave(coords);
  renderAll();
  setTimeout(() => {
    state.burstUntil = 0;
    renderAll();
  }, BURST_MS);
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

  // Once the user pans deliberately, stop yanking the viewport around — and let
  // go of their pin, the way every map app drops out of follow when you drag.
  state.map.addUserPanListener(() => {
    state.userMovedMap = true;
    setFollow(false);
  });

  if (adapter.isTestProvider) {
    el.providerBadge.textContent = adapter.label;
    el.providerBadge.hidden = false;
  }
}

function showMapFallback(detail) {
  el.mapFallbackDetail.textContent = detail;
  el.mapFallback.hidden = false;
  el.mapControls.hidden = true; // nothing left for them to move
  hideLocator();
  document.getElementById('map').style.display = 'none';
}

/**
 * Groups located participants by proximity, so people standing together are one
 * readable pin instead of a stack where only the top one can be read.
 *
 * Leader-based rather than single-link: every member is within CLUSTER_RADIUS_M
 * of its group's anchor. Single-link would let a chain of people ten metres
 * apart merge into one pin covering a whole street, which is the opposite of
 * what "same location" should mean.
 */
function clusterParticipants(located) {
  // The order fixes which participant anchors each group, and the anchor is what
  // the marker is keyed by — so it has to be stable, or pins would change
  // identity between frames and re-drop for no reason. You anchor your own
  // group, and everyone else falls back to id order.
  const ordered = [...located].sort((a, b) => {
    if (a.id === state.selfId) return -1;
    if (b.id === state.selfId) return 1;
    return a.id < b.id ? -1 : 1;
  });

  const groups = [];
  for (const participant of ordered) {
    const group = groups.find(
      (g) => haversineMeters(g.anchor, participant) <= CLUSTER_RADIUS_M,
    );
    if (group) group.members.push(participant);
    else groups.push({ anchor: participant, members: [participant] });
  }
  return groups;
}

/** The point a group's pin sits on: the average of everyone standing there. */
function centroid(members) {
  const lat = members.reduce((sum, m) => sum + m.lat, 0) / members.length;
  const lng = members.reduce((sum, m) => sum + m.lng, 0) / members.length;
  return { lat, lng };
}

function renderMarkers() {
  if (!state.map) return;

  const located = state.participants.filter(
    (p) => p.sharing && typeof p.lat === 'number' && typeof p.lng === 'number',
  );
  const groups = clusterParticipants(located);
  const liveIds = new Set(groups.map((g) => g.anchor.id));

  // Remove pins for people who left, stopped sharing, or merged into a group
  // anchored by somebody else.
  for (const id of state.renderedIds) {
    if (!liveIds.has(id)) {
      state.map.removeMarker(id);
      state.renderedIds.delete(id);
    }
  }

  // Framed before the pins are built, not after: an arriving pin has to know how
  // long the camera will be moving so it can wait for it.
  fitViewport(located);

  const bursting = Date.now() < state.burstUntil;
  const groupSizes = new Map();

  for (const { anchor, members } of groups) {
    const id = anchor.id;
    const isSelf = members.some((m) => m.id === state.selfId);
    // Grey only when nobody standing here is still reporting. One live member is
    // enough to make the position current; the paused ones dim their own face.
    const stale = members.every(isPaused);
    const burst = isSelf && bursting;
    const existing = state.map.hasMarker(id);

    const people = members.map((m) => ({
      name: m.name,
      color: colorFor(m),
      paused: isPaused(m),
      isSelf: m.id === state.selfId,
    }));

    const color = isSelf ? SELF_COLOR : members.length > 1 ? GROUP_COLOR : colorFor(anchor);

    // Somebody walked into a group that was already on the map. There is no
    // pin to drop, so the landing ring fires on its own.
    const joined = existing && members.length > (state.groupSizes.get(id) ?? 0);
    groupSizes.set(id, members.length);

    state.map.upsertMarker(id, {
      position: members.length > 1 ? centroid(members) : { lat: anchor.lat, lng: anchor.lng },
      people,
      color,
      isSelf,
      stale,
      burst,
      joined,
      // A pin the map is not already holding is one that has to emerge. This is
      // what makes a friend's arrival an event rather than a pop-in.
      arrive: !existing,
      // Hold it back until the camera has finished travelling to the spot.
      arriveDelay: existing ? 0 : Math.max(0, state.cameraBusyUntil - Date.now()),
      // The group's uncertainty is the worst of its members'.
      accuracy: members.reduce((worst, m) => Math.max(worst, m.accuracy || 0), 0),
      // Only a state flip rebuilds the pin DOM — deliberately not the age, which
      // changes every second and would rebuild every marker with it.
      signature: [
        people.map((p) => `${p.name}:${p.paused ? 'p' : 'l'}`).join(','),
        color,
        stale ? 'stale' : 'live',
        burst ? 'burst' : '',
        joined ? 'joined' : '',
      ].join('|'),
    });
    state.renderedIds.add(id);
  }

  state.groupSizes = groupSizes;

  // Our real pin supersedes the local-only preview of the same position.
  if (located.some((p) => p.id === state.selfId)) clearPreview();
}

/** Room for the chrome: the panel is a left column on desktop, a sheet on phones. */
function viewportPadding() {
  return window.matchMedia('(min-width: 720px)').matches
    ? { top: 110, right: 96, bottom: 90, left: 400 }
    : { top: 120, right: 76, bottom: 300, left: 44 };
}

function fitViewport(located) {
  // Following beats framing: while it is on, the map has one job.
  if (state.followSelf) {
    const position = selfPosition();
    if (position) state.map.panTo(position);
    return;
  }

  if (located.length === 0 || state.userMovedMap) return;

  if (located.length === 1) {
    if (!state.hasAutoFitted) {
      // Fly rather than jump. The pin is about to come out of this spot, and
      // travelling there first is what makes it read as emerging from the map
      // instead of appearing on top of it.
      flyTo({ lat: located[0].lat, lng: located[0].lng }, FOCUS_ZOOM);
      state.hasAutoFitted = true;
    }
    return;
  }

  state.map.fitBounds(
    located.map((p) => ({ lat: p.lat, lng: p.lng })),
    viewportPadding(),
  );
  state.cameraBusyUntil = Date.now() + FIT_MS;
  state.hasAutoFitted = true;
}

// ------------------------------------------------------------- Map controls

// Close enough to read a street sign. Centring from a world view should arrive
// somewhere useful, but never zoom you back out if you were already closer in.
const FOCUS_ZOOM = 16;

/** Your own position as this browser knows it — shared, or only previewed. */
function selfPosition() {
  const self = state.participants.find((p) => p.id === state.selfId);
  if (self?.sharing && typeof self.lat === 'number' && typeof self.lng === 'number') {
    return { lat: self.lat, lng: self.lng };
  }
  if (state.previewCoords) {
    return { lat: state.previewCoords.lat, lng: state.previewCoords.lng };
  }
  return null;
}

/** Every pin currently on the map, including your own unshared preview. */
function framablePoints() {
  const points = state.participants
    .filter((p) => p.sharing && typeof p.lat === 'number' && typeof p.lng === 'number')
    .map((p) => ({ lat: p.lat, lng: p.lng }));
  // previewCoords is cleared the moment your real pin takes over, so this can
  // never count you twice.
  if (state.previewCoords) {
    points.push({ lat: state.previewCoords.lat, lng: state.previewCoords.lng });
  }
  return points;
}

/**
 * Follow mode: the map keeps your pin in the middle as you move, until you drag
 * the map yourself. The button reports it, because a map that moves on its own
 * is confusing unless something on screen says it is meant to.
 */
function setFollow(on) {
  if (state.followSelf === on) return;
  state.followSelf = on;
  el.centerMe.classList.toggle('is-active', on);
  el.centerMe.setAttribute('aria-pressed', String(on));
}

/** Eases the camera to a point, and records when it will get there. */
function flyTo(position, zoom) {
  state.map?.focusOn(position, zoom);
  state.cameraBusyUntil = Date.now() + FLY_MS;
}

/** Centres on one point and stops the app framing anything by itself. */
function focusOn(position) {
  state.userMovedMap = true; // an explicit choice outranks any auto-fit
  flyTo(position, Math.max(state.map?.getZoom() ?? FOCUS_ZOOM, FOCUS_ZOOM));
}

function updateMapControls() {
  // Never dead while a position is obtainable: with no fix of its own this is
  // the button that goes and gets one, which is the only way back if the first
  // attempt was denied, dismissed or timed out.
  el.centerMe.disabled = !selfPosition() && !CAN_LOCATE;
  el.frameAll.disabled = framablePoints().length === 0;
}

el.centerMe.addEventListener('click', () => {
  const position = selfPosition();
  if (!position) {
    // Straight to the precise backend: this is a deliberate ask, and whatever
    // was going to answer quickly has already had its chance.
    previewLocation({ retry: true, asked: true });
    return;
  }
  setFollow(true);
  focusOn(position);
});

el.frameAll.addEventListener('click', () => {
  const points = framablePoints();
  if (points.length === 0) return;

  setFollow(false);
  state.userMovedMap = true;

  // One pin has no bounds to fit; it just becomes a centre.
  if (points.length === 1) {
    flyTo(points[0], Math.max(state.map.getZoom(), FOCUS_ZOOM));
    return;
  }
  state.map.fitBounds(points, viewportPadding());
  state.cameraBusyUntil = Date.now() + FIT_MS;
});

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

  let arrivals = 0;

  for (const participant of state.participants) {
    const isSelf = participant.id === state.selfId;
    const paused = participant.sharing && participant.lat !== null && isPaused(participant);
    const live = participant.sharing && participant.lat !== null && !paused;

    const li = document.createElement('li');
    li.className = 'person' + (isSelf ? ' is-self' : '') + (paused ? ' is-paused' : '');
    li.style.setProperty('--person-color', colorFor(participant));

    // A row that was not here a moment ago slides in and flashes its colour.
    // Rows already on screen must not replay it on the next 10-second tick.
    if (!state.seenIds.has(participant.id)) {
      li.classList.add('is-new');
      li.style.animationDelay = `${arrivals * 80}ms`;
      arrivals += 1;
    }

    const avatar = document.createElement('span');
    avatar.className = 'avatar' + (live ? ' avatar-live' : '');
    avatar.textContent = (participant.name.trim()[0] || '?').toUpperCase();

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
      if (!isSelf && self?.sharing && self.lat !== null) {
        const distance = document.createElement('span');
        distance.className = 'distance';
        distance.textContent = formatDistance(haversineMeters(self, participant));
        meta.append(distance, ' · ');
      }
      // Saying "last seen" rather than "updated" is the whole point: the number
      // is the same, but one implies the pin is current and the other does not.
      if (participant.away) {
        meta.append(`paused · last seen ${formatAgo(participant.updatedAt)}`);
      } else if (isStale(participant)) {
        meta.append(`no signal · last seen ${formatAgo(participant.updatedAt)}`);
      } else {
        meta.append(`updated ${formatAgo(participant.updatedAt)}`);
      }
    }

    text.append(name, meta);

    // The row itself centres the map on that person. A "Center" button on every
    // row was more chrome than the map controls it duplicated — and with a
    // roomful of people it was most of the panel.
    const placed = participant.sharing && participant.lat !== null;
    const body = document.createElement(placed ? 'button' : 'div');
    body.className = 'person-body';
    if (placed) {
      body.type = 'button';
      body.title = isSelf ? 'Centre the map on you' : `Centre the map on ${participant.name}`;
      body.addEventListener('click', () => {
        // Centring on yourself is the same intent as the follow button; on
        // anyone else it is a one-off look, so following has to stop.
        setFollow(isSelf);
        focusOn({ lat: participant.lat, lng: participant.lng });
      });
    }
    body.append(avatar, text);
    li.append(body);

    if (isSelf) {
      const rename = document.createElement('button');
      rename.className = 'link-button';
      rename.textContent = 'Rename';
      rename.addEventListener('click', () => openNameDialog('edit'));
      li.append(rename);
    }

    el.people.append(li);
  }

  // Anyone still here has now had their entrance; anyone who left forfeits it,
  // so a rejoin is announced again.
  state.seenIds = new Set(state.participants.map((p) => p.id));

  // Shown below your own row, so the roster still reads top-down. While you are
  // the only one here there is nothing to list, so the space does the teaching
  // instead — and it retires itself the moment somebody joins.
  if (state.participants.length <= 1) el.people.append(buildEmptyState());

  updateCounts();
  updateMapControls();
}

/**
 * What to do next, in the order you have to do it. Which step is outstanding
 * depends on whether you are sharing yet, so the list never tells you to do
 * something you have already done.
 */
function buildEmptyState() {
  const li = document.createElement('li');
  li.className = 'person empty';

  const title = document.createElement('div');
  title.className = 'empty-title';
  title.textContent = state.sharing ? 'Your pin is live' : 'Getting started';

  const steps = document.createElement('ol');
  steps.className = 'empty-steps';

  const lines = state.sharing
    ? [
        ['Share link', 'send it to whoever you are meeting.'],
        ['Watch them land', 'their pin drops onto this map as they join.'],
      ]
    : [
        ['Send my location', 'puts your pin on the map. Nothing is sent before you press it.'],
        ['Share link', 'anyone who opens it joins this same map.'],
        ['Watch them land', 'pins update live, with distances below.'],
      ];

  for (const [action, rest] of lines) {
    const step = document.createElement('li');
    // One wrapper, not a <strong> plus a loose text node: the row is a two
    // column grid, and a bare text node would become a third item squeezed into
    // an implicit column one word wide.
    const text = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = action;
    text.append(strong, ` — ${rest}`);
    step.append(text);
    steps.append(step);
  }

  li.append(title, steps);
  return li;
}

function updateCounts() {
  const count = String(state.participants.length || 1);
  el.crewCount.textContent = count;

  if (el.countBadge.textContent !== count) {
    el.countBadge.textContent = count;
    el.countBadge.classList.remove('is-bumped');
    void el.countBadge.offsetWidth;
    el.countBadge.classList.add('is-bumped');
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
  setStatus('Connecting…');

  socket.addEventListener('open', () => {
    state.reconnectDelay = 1000;
    setStatus('Connected');
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
      announceArrivals(msg.participants);
      state.participants = msg.participants;
      const others = state.participants.length - 1;
      setStatus(others <= 0 ? 'Waiting for friends' : `${others + 1} people here`);
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
      setStatus(msg.message, { bad: true });
    }
  });

  socket.addEventListener('close', () => {
    setStatus('Reconnecting…', { bad: true });
    // Every member gets a fresh id on reconnect, so the next roster would read
    // as the whole room arriving at once. Clearing this makes it the baseline.
    state.announced.clear();
    setTimeout(connect, state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, 15000);
  });
}

function setStatus(message, { bad = false } = {}) {
  el.status.textContent = message;
  el.statusChip.classList.toggle('is-bad', bad);
}

/**
 * Says who just walked in. Only the first roster we ever receive is silent —
 * everyone in it was already here, so announcing them would be a lie.
 */
function announceArrivals(participants) {
  const known = state.announced.size > 0;

  for (const participant of participants) {
    if (state.announced.has(participant.id)) continue;
    state.announced.add(participant.id);
    if (known && participant.id !== state.selfId) toast(`${participant.name} joined`);
  }

  // Forget anyone who left, so a rejoin is announced again.
  const present = new Set(participants.map((p) => p.id));
  for (const id of state.announced) {
    if (!present.has(id)) state.announced.delete(id);
  }
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
  if (!CAN_LOCATE) return;

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
 * What the browser will do if we ask for a position right now. Worth knowing
 * before we ask: an unanswered permission dialog is the one case where
 * getCurrentPosition neither resolves nor times out, and telling the user
 * "Finding you…" while a dialog waits for them is a dead end.
 */
async function geolocationPermission() {
  try {
    const status = await navigator.permissions?.query({ name: 'geolocation' });
    return status?.state ?? 'unknown';
  } catch {
    return 'unknown'; // older Safari has no Permissions API for geolocation
  }
}

/**
 * Puts the map where the user actually is the moment the room opens, so it
 * never starts as a blank world view. This is a single read, kept entirely in
 * this browser — nothing reaches the server until "Send my location" is pressed.
 *
 * @param {{retry?: boolean}} [options] - `retry` asks the precise backend after
 *   the quick coarse attempt came back empty.
 */
async function previewLocation({ retry = false, asked = false } = {}) {
  if (!CAN_LOCATE || state.previewPending) return;
  state.previewPending = true;

  const permission = await geolocationPermission();
  if (permission === 'denied') {
    state.previewPending = false;
    reportPreviewBlocked(asked);
    return;
  }

  // Chrome does not start the timeout until its dialog is answered, so a prompt
  // nobody has noticed leaves this pending forever. Name what is being waited on
  // rather than implying the app is busy looking.
  showLocator(permission === 'prompt' ? 'Allow location to place your pin' : 'Finding you…');

  navigator.geolocation.getCurrentPosition(
    (position) => {
      state.previewPending = false;
      hideLocator();
      if (state.sharing) return; // real sharing started first; it owns the pin
      state.previewCoords = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy,
      };
      renderPreview();
    },
    (error) => {
      state.previewPending = false;

      // The quick coarse attempt is the cheap first try. When it comes back
      // unavailable or times out — routine on a desktop with no Wi-Fi lookup —
      // the precise backend often still has an answer, so ask it once before
      // giving up and leaving the user on a world view.
      if (!retry && (error.code === 2 || error.code === 3)) {
        previewLocation({ retry: true, asked });
        return;
      }

      hideLocator();
      if (error.code === 1) reportPreviewBlocked(asked);
    },
    retry
      ? { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
      : // A cached, coarse fix is fine — this is only about framing the map.
        { enableHighAccuracy: false, maximumAge: 300000, timeout: 8000 },
  );
}

/**
 * Said when the browser refuses. Staying silent here is what left the room
 * sitting on a world view with nothing to explain it and no obvious way back.
 *
 * @param {boolean} asked - whether the user pressed the locate key for this. A
 *   refusal they walked into gets a quiet line; one they just asked about gets
 *   the instructions, because a blocked permission never re-prompts and there is
 *   nothing else for the button to usefully do.
 */
function reportPreviewBlocked(asked) {
  hideLocator();
  if (asked) {
    openGuide('blocked');
    return;
  }
  toast('Location is blocked. Tap the locate key to see how to turn it back on.');
}

// ------------------------------------------------------------------- Guide

/**
 * @param {'help'|'blocked'} mode - 'blocked' names the problem and lifts the
 *   unblocking steps to the top; the rest of the reference stays below either
 *   way, so there is only ever one document to maintain.
 */
function openGuide(mode = 'help') {
  const blocked = mode === 'blocked';
  el.guideDialog.dataset.mode = mode;
  el.guideTitle.textContent = blocked ? 'Location is blocked' : 'How Meet Up works';
  el.guideLede.textContent = blocked
    ? 'Your browser is refusing this site’s location requests, so it cannot put your pin on the map. Here is how to turn it back on.'
    : 'A meetup is one map that everybody with the link can see.';
  if (!el.guideDialog.open) el.guideDialog.showModal();
}

el.guideButton.addEventListener('click', () => openGuide('help'));
el.guideClose.addEventListener('click', () => el.guideDialog.close());
el.guideDone.addEventListener('click', () => el.guideDialog.close());

function renderPreview() {
  if (!state.map || !state.previewCoords) return;

  const { lat, lng, accuracy } = state.previewCoords;

  // Only claim the viewport while it is still the default world view — never
  // fight an auto-fit over real participants or a pan the user made. Ordered
  // before the marker so the pin can wait out the flight.
  if (!state.userMovedMap && !state.hasAutoFitted) {
    flyTo({ lat, lng }, FOCUS_ZOOM);
    // This frame counts. Without it, pressing "Send my location" would fly to
    // the same spot a second time and make the real pin sit invisible through a
    // flight that never moves the map.
    state.hasAutoFitted = true;
  }

  state.map.upsertMarker(PREVIEW_ID, {
    position: { lat, lng },
    people: [{ name: state.name || 'You', color: SELF_COLOR, isSelf: true }],
    color: SELF_COLOR,
    isSelf: true,
    muted: true,
    accuracy,
    arrive: !state.map.hasMarker(PREVIEW_ID),
    arriveDelay: Math.max(0, state.cameraBusyUntil - Date.now()),
    signature: 'preview',
  });

  // The preview is a pin the controls can act on, so they stop being inert as
  // soon as it lands — well before anything has been shared with the room.
  updateMapControls();
}

function clearPreview() {
  if (!state.previewCoords) return;
  state.previewCoords = null;
  state.map?.removeMarker(PREVIEW_ID);
  updateMapControls();
}

// --------------------------------------------------------------- Geolocation

/** The share button carries three states, and says which one it is in. */
function setShareButton(mode) {
  el.shareToggle.classList.remove('btn-lime', 'btn-ghost', 'btn-live');

  if (mode === 'live') {
    el.shareToggle.classList.add('btn-ghost', 'btn-live');
    el.shareToggle.textContent = 'Stop sharing';
    el.shareToggle.disabled = false;
    return;
  }

  el.shareToggle.classList.add('btn-lime');
  el.shareToggle.textContent = mode === 'pending' ? 'Locking in your position…' : 'Send my location';
  el.shareToggle.disabled = mode === 'pending';
}

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

  setShareButton('pending');
  showLocator(resumed ? 'Picking your location back up…' : 'Locking in your position…');

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
        hideLocator();
        clearPreview(); // the shared pin takes over from here
        setShareButton('live');
        toast(
          resumed
            ? 'Sharing picked back up after the page reloaded.'
            : 'You’re live. Anyone with the link can see your pin.',
        );
        sendLocation(coords);
        // Rings leave the pin only once the room actually has the position.
        celebrateGoLive(coords);
        return;
      }
      sendLocation(coords);
    },
    (error) => {
      stopSharing({ silent: true });
      hideLocator();

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
  setShareButton('idle');
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({ type: 'stop' }));
  }
  if (!silent) toast('You stopped sharing your location.');
}

function showGeoError(message) {
  el.geoError.textContent = message;
  el.geoError.hidden = false;
  hideLocator();
  setShareButton('idle');
}

el.shareToggle.addEventListener('click', () => {
  sweep(el.shareToggle);
  if (state.sharing) stopSharing();
  else startSharing();
});

// -------------------------------------------------------------------- Share

el.shareLink.addEventListener('click', async () => {
  sweep(el.shareLink);
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

/**
 * On a phone the map controls float just above the sheet, and the sheet's height
 * depends on how many people are in the room. Publishing the measured height
 * lets CSS place them exactly, instead of guessing a clearance that is wrong for
 * an empty room and wrong again for a full one.
 */
if ('ResizeObserver' in window) {
  new ResizeObserver(() => {
    // offsetHeight, not contentRect: the sheet's bottom padding carries the
    // safe-area inset, and the controls have to clear that too.
    document.body.style.setProperty('--panel-height', `${el.panel.offsetHeight}px`);
  }).observe(el.panel);
}

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
  setStatus('Enter your name to join');
  openNameDialog('join');
}

initMap()
  .then(() => {
    renderAll();
    renderPreview();
  })
  .catch((err) => showMapFallback(err.message));
