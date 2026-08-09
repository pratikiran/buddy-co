// Google Maps adapter — the production map.
// Implements the shared map interface consumed by app.js:
//   init, addUserPanListener, upsertMarker, removeMarker, fitBounds,
//   focusOn, getZoom
import { buildPinElement } from './pin.js';

export const label = 'Google Maps';
export const isTestProvider = false;

export async function createMap(container, config) {
  // Google calls this global when the key itself is rejected (bad key, API not
  // enabled, referrer blocked). Without it the map just silently greys out.
  const authFailure = new Promise((_, reject) => {
    window.gm_authFailure = () =>
      reject(
        new Error(
          'Google rejected the API key. Check that the "Maps JavaScript API" is enabled, that billing is on, and that the key\'s HTTP referrer restrictions allow http://localhost:3000/*. Set MAP_PROVIDER=osm in .env to test without a key.',
        ),
      );
  });

  const loaded = new Promise((resolve, reject) => {
    const callbackName = '__meetupMapsReady';
    window[callbackName] = resolve;
    const script = document.createElement('script');
    script.src =
      'https://maps.googleapis.com/maps/api/js' +
      `?key=${encodeURIComponent(config.mapsApiKey)}` +
      '&v=weekly&libraries=marker&loading=async' +
      `&callback=${callbackName}`;
    script.async = true;
    script.onerror = () =>
      reject(new Error('Could not reach maps.googleapis.com. Check your internet connection.'));
    document.head.appendChild(script);
  });

  await Promise.race([loaded, authFailure]);

  // Aliased: Google's Map class would otherwise shadow the global Map we use below.
  const [{ Map: GoogleMap }, { AdvancedMarkerElement }] = await Promise.all([
    google.maps.importLibrary('maps'),
    google.maps.importLibrary('marker'),
  ]);

  const map = new GoogleMap(container, {
    center: { lat: 20, lng: 0 },
    zoom: 2,
    mapId: config.mapId,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    clickableIcons: false,
    gestureHandling: 'greedy',
  });

  const markers = new Map();

  return {
    addUserPanListener(onPan) {
      map.addListener('dragstart', onPan);
    },

    upsertMarker(id, { position, name, color, isSelf, accuracy, signature }) {
      let entry = markers.get(id);
      if (!entry) {
        const marker = new AdvancedMarkerElement({
          map,
          position,
          content: buildPinElement({ name, color, isSelf }),
          title: isSelf ? 'You' : name,
          zIndex: isSelf ? 10 : 1,
        });
        const accuracyCircle = new google.maps.Circle({
          map,
          center: position,
          radius: accuracy || 0,
          strokeColor: color,
          strokeOpacity: 0.35,
          strokeWeight: 1,
          fillColor: color,
          fillOpacity: 0.12,
          clickable: false,
        });
        entry = { marker, accuracyCircle, signature };
        markers.set(id, entry);
      } else {
        entry.marker.position = position;
        // Only swap the pin DOM when the label or colour actually changed —
        // rebuilding it every GPS tick would restart the pulse animation.
        if (entry.signature !== signature) {
          entry.marker.content = buildPinElement({ name, color, isSelf });
          entry.marker.title = isSelf ? 'You' : name;
          entry.signature = signature;
        }
        entry.accuracyCircle.setCenter(position);
        entry.accuracyCircle.setRadius(accuracy || 0);
      }
      entry.accuracyCircle.setVisible(Boolean(accuracy));
    },

    removeMarker(id) {
      const entry = markers.get(id);
      if (!entry) return;
      entry.marker.map = null;
      entry.accuracyCircle.setMap(null);
      markers.delete(id);
    },

    hasMarker: (id) => markers.has(id),

    fitBounds(points, padding) {
      const bounds = new google.maps.LatLngBounds();
      for (const p of points) bounds.extend(p);
      map.fitBounds(bounds, padding);
    },

    focusOn(position, zoom) {
      map.panTo(position);
      map.setZoom(zoom);
    },

    setCenter(position, zoom) {
      map.setCenter(position);
      map.setZoom(zoom);
    },

    getZoom: () => map.getZoom() ?? 15,
  };
}
