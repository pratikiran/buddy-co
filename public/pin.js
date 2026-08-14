// The pin DOM is shared by both map providers so a pin looks identical whether
// it is rendered by Google's AdvancedMarkerElement or Leaflet's divIcon.

// How many faces fit in a group's label before the rest become a count.
const MAX_FACES = 3;

/**
 * @param {object} options
 * @param {{name: string, color: string, paused?: boolean, isSelf?: boolean}[]}
 *   options.people - everyone standing at this point. One entry is an ordinary
 *   pin; more than one is a group drawn as a single pin, because pins closer
 *   together than a few metres overlap into something nobody can read.
 * @param {string} options.color - the pin's own colour: your lime, one friend's
 *   identity colour, or neutral white for a group of other people.
 * @param {boolean} [options.muted] - a pin only this browser can see: your own
 *   position before you have opted into sharing it with the room.
 * @param {boolean} [options.stale] - the position is the last one we were told
 *   about, not where they are now. Without this a phone that backgrounded the
 *   tab keeps a pin that looks indistinguishable from a live one.
 * @param {boolean} [options.arrive] - grow the pin out of its own coordinate.
 *   Set once, when the marker is created, so a rebuild caused by a rename or a
 *   staleness flip never replays it.
 * @param {number} [options.arriveDelay] - milliseconds to wait before emerging,
 *   so the pin comes out of a spot the camera has already reached.
 * @param {boolean} [options.burst] - the one-off broadcast the pin fires the
 *   moment its owner goes live.
 * @param {boolean} [options.joined] - somebody walked into a group that was
 *   already on the map. There is no pin to drop, so the landing ring fires alone.
 */
export function buildPinElement({
  people,
  color,
  isSelf,
  muted,
  stale,
  arrive,
  arriveDelay,
  burst,
  joined,
}) {
  const group = people.length > 1;
  const live = !muted && !stale;

  const wrap = document.createElement('div');
  wrap.className = [
    'pin',
    isSelf && 'pin-self',
    group && 'pin-group',
    muted && 'pin-muted',
    stale && 'pin-stale',
    live && 'pin-live',
    arrive && 'pin-arrive',
    burst && 'pin-burst',
    joined && 'pin-joined',
  ]
    .filter(Boolean)
    .join(' ');
  // The identity colour, not the drawn colour: an inline custom property would
  // outrank any class rule, which is how .pin-stale used to lose its grey. CSS
  // resolves --pin-color from this, and can override it per state.
  wrap.style.setProperty('--pin-identity', color);
  if (arrive && arriveDelay > 0) {
    wrap.style.setProperty('--arrive-delay', `${Math.round(arriveDelay)}ms`);
  }

  const label = document.createElement('span');
  label.className = 'pin-label';

  // One face per person, overlapping, capped — then a count for the remainder.
  const faces = document.createElement('span');
  faces.className = 'pin-faces';
  for (const person of people.slice(0, MAX_FACES)) {
    const face = document.createElement('span');
    face.className = 'pin-initial' + (person.paused ? ' is-paused' : '');
    face.style.setProperty('--pin-face', person.color);
    face.textContent = initialFor(person.name);
    faces.append(face);
  }
  if (people.length > MAX_FACES) {
    const rest = document.createElement('span');
    rest.className = 'pin-initial is-rest';
    rest.textContent = `+${people.length - MAX_FACES}`;
    faces.append(rest);
  }

  const text = document.createElement('span');
  text.className = 'pin-name';
  text.textContent = describe(people, muted);

  label.append(faces, text);

  const stem = document.createElement('span');
  stem.className = 'pin-stem';

  const dot = document.createElement('span');
  dot.className = 'pin-dot';
  const core = document.createElement('span');
  if (group) {
    // A group's dot says how many people it stands for, so the count is legible
    // even when the label is off past the edge of the screen.
    core.className = 'pin-count';
    core.textContent = String(people.length);
  } else {
    core.className = 'pin-core';
  }
  dot.append(core);

  // Rings live under the dot: the live heartbeat, the go-live burst and the
  // landing impact all expand from the same point on the ground.
  const waves = [1, 2].map((n) => {
    const wave = document.createElement('span');
    wave.className = `pin-wave pin-wave-${n}`;
    return wave;
  });

  // The ring that leaves the ground as the pin comes out of it.
  const surge = document.createElement('span');
  surge.className = 'pin-surge';

  wrap.append(label, stem, dot, ...waves, surge);
  return wrap;
}

/**
 * What the label reads. "You" comes first because app.js anchors your own group,
 * so a group you are standing in is described from you outwards.
 */
export function describe(people, muted) {
  const names = people.map((p) => (p.isSelf ? 'You' : p.name));

  if (names.length === 1) return muted ? 'You (not shared)' : names[0];
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} & ${names[2]}`;
  return `${names[0]}, ${names[1]} & ${names.length - 2} more`;
}

/** First letter of the name, so a face is identifiable even zoomed out. */
function initialFor(name) {
  return (String(name || '?').trim()[0] || '?').toUpperCase();
}

export function buildPinHTML(options) {
  return buildPinElement(options).outerHTML;
}
