// OpenStreetMap + Leaflet adapter — the keyless test provider.
// Deliberately implements the exact same interface as map-google.js so that
// exercising the app on OSM exercises the same application code paths.
import { buildPinHTML } from './pin.js';

export const label = 'OpenStreetMap (test)';
export const isTestProvider = true;

// CARTO's dark basemap, rendered from OpenStreetMap data. The app is black with
// one lime accent; a white basemap would fight every pin on it, and tinting the
// standard tiles with a CSS filter wrecks the label contrast.
const TILE_URL = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
// Closest an automatic fit is allowed to go. Street level, not rooftop level.
const MAX_FIT_ZOOM = 17;
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

function loadStylesheet(href) {
  return new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.onload = resolve;
    link.onerror = () => reject(new Error(`Could not load ${href}`));
    document.head.appendChild(link);
  });
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(script);
  });
}

export async function createMap(container) {
  // Both files are served from node_modules by our own server — no CDN, so this
  // works offline and cannot be broken by a third party.
  await loadStylesheet('/vendor/leaflet/leaflet.css');
  await loadScript('/vendor/leaflet/leaflet.js');

  const L = window.L;
  if (!L) throw new Error('Leaflet loaded but did not register itself.');

  const map = L.map(container, {
    center: [20, 0],
    zoom: 2,
    zoomControl: false,
    attributionControl: true,
    worldCopyJump: true,
  });

  // Bottom-right is the only corner no app chrome covers: the panel is a left
  // column on desktop, and on phones these keys are hidden in favour of pinch.
  L.control.zoom({ position: 'bottomright' }).addTo(map);

  L.tileLayer(TILE_URL, {
    maxZoom: 20,
    subdomains: 'abcd',
    attribution: TILE_ATTRIBUTION,
  }).addTo(map);

  // Markers tween between fixes (see .leaflet-marker-icon), which is right for a
  // person walking but wrong mid-zoom, where Leaflet rewrites every marker
  // transform at once and the tween would read as the pins sliding off.
  map.on('zoomstart', () => container.classList.add('is-zooming'));
  map.on('zoomend', () => {
    requestAnimationFrame(() => container.classList.remove('is-zooming'));
  });

  // Leaflet measures the container once at construction. If it was still being
  // laid out (fonts, mobile viewport units, an orientation change) it requests
  // tiles for the wrong box and the map renders blank or half-filled, so
  // re-measure whenever the container's size actually changes.
  if ('ResizeObserver' in window) {
    new ResizeObserver(() => map.invalidateSize({ animate: false })).observe(container);
  } else {
    window.addEventListener('resize', () => map.invalidateSize({ animate: false }));
  }

  const markers = new Map();

  /** Leaflet needs explicit icon geometry; anchor the dot's centre on the point. */
  function iconFor(options) {
    return L.divIcon({
      html: `<div class="pin-anchor">${buildPinHTML(options)}</div>`,
      className: 'pin-divicon', // suppress Leaflet's default white box
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });
  }

  return {
    addUserPanListener(onPan) {
      map.on('dragstart', onPan);
    },

    upsertMarker(
      id,
      {
        position,
        people,
        color,
        isSelf,
        muted,
        stale,
        arrive,
        arriveDelay,
        burst,
        joined,
        accuracy,
        signature,
      },
    ) {
      const latlng = [position.lat, position.lng];
      const pin = { people, color, isSelf, muted, stale, burst, joined };
      let entry = markers.get(id);

      if (!entry) {
        const marker = L.marker(latlng, {
          icon: iconFor({ ...pin, arrive, arriveDelay }),
          zIndexOffset: isSelf ? 1000 : 0,
          interactive: false,
        }).addTo(map);
        const accuracyCircle = L.circle(latlng, {
          radius: accuracy || 0,
          color,
          opacity: 0.3,
          weight: 1,
          fillColor: color,
          fillOpacity: 0.07,
          interactive: false,
        }).addTo(map);
        entry = { marker, accuracyCircle, signature };
        markers.set(id, entry);
      } else {
        entry.marker.setLatLng(latlng);
        // Only rebuild the icon when the label or colour changed — otherwise the
        // pulse animation restarts on every GPS tick. `arrive` is never passed
        // here: a pin already on the map has arrived.
        if (entry.signature !== signature) {
          entry.marker.setIcon(iconFor(pin));
          entry.signature = signature;
        }
        entry.accuracyCircle.setLatLng(latlng);
        entry.accuracyCircle.setRadius(accuracy || 0);
      }

      // Leaflet has no setVisible; radius 0 is the equivalent no-op.
      if (!accuracy) entry.accuracyCircle.setRadius(0);
    },

    removeMarker(id) {
      const entry = markers.get(id);
      if (!entry) return;
      map.removeLayer(entry.marker);
      map.removeLayer(entry.accuracyCircle);
      markers.delete(id);
    },

    hasMarker: (id) => markers.has(id),

    /** Screen-space position, for effects drawn in the page rather than the map. */
    toPixel(position) {
      const point = map.latLngToContainerPoint([position.lat, position.lng]);
      return { x: point.x, y: point.y };
    },

    fitBounds(points, padding) {
      const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng]));
      map.fitBounds(bounds, {
        paddingTopLeft: [padding.left, padding.top],
        paddingBottomRight: [padding.right, padding.bottom],
        // Two friends standing together make a bounds box of nearly zero size,
        // which otherwise fits at maximum zoom — a view of one rooftop.
        maxZoom: MAX_FIT_ZOOM,
      });
    },

    focusOn(position, zoom) {
      map.flyTo([position.lat, position.lng], zoom, { duration: 0.9 });
    },

    /** Follow mode's every-fix nudge: keeps the zoom, just re-centres. */
    panTo(position) {
      map.panTo([position.lat, position.lng], { animate: true, duration: 0.5 });
    },

    setCenter(position, zoom) {
      map.setView([position.lat, position.lng], zoom);
    },

    getZoom: () => map.getZoom() ?? 15,
  };
}
