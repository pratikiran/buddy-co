// The pin DOM is shared by both map providers so a pin looks identical whether
// it is rendered by Google's AdvancedMarkerElement or Leaflet's divIcon.

// `muted` marks a pin that only this browser can see — your own position before
// you have opted into sharing it with the room.
// `stale` marks a pin whose owner has stopped reporting: the position is the
// last one we were told about, not where they are now. Without this a phone that
// backgrounded the tab keeps a pin that looks indistinguishable from a live one.
export function buildPinElement({ name, color, isSelf, muted, stale }) {
  const wrap = document.createElement('div');
  wrap.className =
    'pin' + (isSelf ? ' pin-self' : '') + (muted ? ' pin-muted' : '') + (stale ? ' pin-stale' : '');
  wrap.style.setProperty('--pin-color', color);

  const label = document.createElement('span');
  label.className = 'pin-label';
  label.textContent = muted ? 'You (not shared)' : isSelf ? 'You' : name;

  const dot = document.createElement('span');
  dot.className = 'pin-dot';

  wrap.append(label, dot);
  return wrap;
}

export function buildPinHTML(options) {
  return buildPinElement(options).outerHTML;
}
