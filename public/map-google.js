// Google Maps adapter — the production map.
// Implements the shared map interface consumed by app.js:
//   addUserPanListener, upsertMarker, removeMarker, hasMarker, toPixel,
//   fitBounds, focusOn, setCenter, getZoom
import { buildPinElement, describe } from './pin.js';

export const label = 'Google Maps';
export const isTestProvider = false;

// Closest an automatic fit is allowed to go. Street level, not rooftop level.
const MAX_FIT_ZOOM = 17;

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
    // A styled Map ID overrides `styles`, so the dark basemap this design needs
    // has to come from colorScheme. Older API versions ignore the option rather
    // than failing, which just leaves the map light.
    colorScheme: 'DARK',
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    clickableIcons: false,
    gestureHandling: 'greedy',
    // Bottom-right, mirroring the Leaflet adapter: the panel owns the left
    // column on desktop and the bottom sheet on phones.
    zoomControlOptions: { position: google.maps.ControlPosition.RIGHT_BOTTOM },
  });

  // An empty overlay, kept only for its projection: it is the supported way to
  // turn a coordinate into a pixel in the map container.
  const projector = new google.maps.OverlayView();
  projector.onAdd = () => {};
  projector.onRemove = () => {};
  projector.draw = () => {};
  projector.setMap(map);

  const markers = new Map();

  return {
    addUserPanListener(onPan) {
      map.addListener('dragstart', onPan);
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
      const pin = { people, color, isSelf, muted, stale, burst, joined };
      let entry = markers.get(id);

      if (!entry) {
        const marker = new AdvancedMarkerElement({
          map,
          position,
          content: buildPinElement({ ...pin, arrive, arriveDelay }),
          title: describe(people, muted),
          zIndex: isSelf ? 10 : 1,
        });
        const accuracyCircle = new google.maps.Circle({
          map,
          center: position,
          radius: accuracy || 0,
          strokeColor: color,
          strokeOpacity: 0.3,
          strokeWeight: 1,
          fillColor: color,
          fillOpacity: 0.07,
          clickable: false,
        });
        entry = { marker, accuracyCircle, signature };
        markers.set(id, entry);
      } else {
        entry.marker.position = position;
        // Only swap the pin DOM when the label or colour actually changed —
        // rebuilding it every GPS tick would restart the pulse animation.
        // `arrive` is never passed here: a pin already on the map has arrived.
        if (entry.signature !== signature) {
          entry.marker.content = buildPinElement(pin);
          entry.marker.title = describe(people, muted);
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

    /** Screen-space position, for effects drawn in the page rather than the map. */
    toPixel(position) {
      const projection = projector.getProjection();
      if (!projection) return null; // the overlay has not been drawn yet
      const point = projection.fromLatLngToContainerPixel(
        new google.maps.LatLng(position.lat, position.lng),
      );
      return point ? { x: point.x, y: point.y } : null;
    },

    fitBounds(points, padding) {
      const bounds = new google.maps.LatLngBounds();
      for (const p of points) bounds.extend(p);
      map.fitBounds(bounds, padding);
      // Two friends standing together make a bounds box of nearly zero size,
      // which otherwise fits at maximum zoom — a view of one rooftop. Google has
      // no maxZoom option on fitBounds, so clamp once the move has settled.
      google.maps.event.addListenerOnce(map, 'idle', () => {
        if (map.getZoom() > MAX_FIT_ZOOM) map.setZoom(MAX_FIT_ZOOM);
      });
    },

    focusOn(position, zoom) {
      map.panTo(position);
      map.setZoom(zoom);
    },

    /** Follow mode's every-fix nudge: keeps the zoom, just re-centres. */
    panTo(position) {
      map.panTo(position);
    },

    setCenter(position, zoom) {
      map.setCenter(position);
      map.setZoom(zoom);
    },

    getZoom: () => map.getZoom() ?? 15,
  };
}
