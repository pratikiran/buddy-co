// OpenStreetMap + Leaflet adapter — the keyless test provider.
// Deliberately implements the exact same interface as map-google.js so that
// exercising the app on OSM exercises the same application code paths.
import { buildPinHTML } from './pin.js';

export const label = 'OpenStreetMap (test)';
export const isTestProvider = true;

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

  // Top-left is the only corner no app chrome covers: the roster panel owns the
  // bottom (full width on mobile, bottom-right on desktop) and the topbar owns
  // the top strip, which the CSS offset below clears.
  L.control.zoom({ position: 'topleft' }).addTo(map);

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

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
  function iconFor({ name, color, isSelf, muted }) {
    return L.divIcon({
      html: `<div class="pin-anchor">${buildPinHTML({ name, color, isSelf, muted })}</div>`,
      className: 'pin-divicon', // suppress Leaflet's default white box
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });
  }

  return {
    addUserPanListener(onPan) {
      map.on('dragstart', onPan);
    },

    upsertMarker(id, { position, name, color, isSelf, muted, accuracy, signature }) {
      const latlng = [position.lat, position.lng];
      let entry = markers.get(id);

      if (!entry) {
        const marker = L.marker(latlng, {
          icon: iconFor({ name, color, isSelf, muted }),
          zIndexOffset: isSelf ? 1000 : 0,
          interactive: false,
        }).addTo(map);
        const accuracyCircle = L.circle(latlng, {
          radius: accuracy || 0,
          color,
          opacity: 0.35,
          weight: 1,
          fillColor: color,
          fillOpacity: 0.12,
          interactive: false,
        }).addTo(map);
        entry = { marker, accuracyCircle, signature };
        markers.set(id, entry);
      } else {
        entry.marker.setLatLng(latlng);
        // Only rebuild the icon when the label or colour changed — otherwise the
        // pulse animation restarts on every GPS tick.
        if (entry.signature !== signature) {
          entry.marker.setIcon(iconFor({ name, color, isSelf, muted }));
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

    fitBounds(points, padding) {
      const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng]));
      map.fitBounds(bounds, {
        paddingTopLeft: [padding.left, padding.top],
        paddingBottomRight: [padding.right, padding.bottom],
      });
    },

    focusOn(position, zoom) {
      map.panTo([position.lat, position.lng]);
      map.setZoom(zoom);
    },

    setCenter(position, zoom) {
      map.setView([position.lat, position.lng], zoom);
    },

    getZoom: () => map.getZoom() ?? 15,
  };
}
