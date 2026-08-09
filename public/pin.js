// The pin DOM is shared by both map providers so a pin looks identical whether
// it is rendered by Google's AdvancedMarkerElement or Leaflet's divIcon.

export function buildPinElement({ name, color, isSelf }) {
  const wrap = document.createElement('div');
  wrap.className = 'pin' + (isSelf ? ' pin-self' : '');
  wrap.style.setProperty('--pin-color', color);

  const label = document.createElement('span');
  label.className = 'pin-label';
  label.textContent = isSelf ? 'You' : name;

  const dot = document.createElement('span');
  dot.className = 'pin-dot';

  wrap.append(label, dot);
  return wrap;
}

export function buildPinHTML(options) {
  return buildPinElement(options).outerHTML;
}
