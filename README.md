# Meet Up (MVP)

Share your live location with friends on a Google Map via a link. You start a meetup, send
the link, and every person who taps **Send my location** appears as their own pin — on
everybody's map, updating live.

## Quick start

```bash
npm install
npm start
```

Open <http://localhost:3000>. It works immediately — with no API key it renders on
OpenStreetMap so you can test everything today.

If port 3000 is already taken (`EADDRINUSE`), pick another one — the boot log always prints
the URL it actually bound:

```bash
PORT=3100 npm start        # or set PORT= in .env
```

## The two maps

Google Maps is the real map this app ships with. OpenStreetMap + Leaflet is a keyless
stand-in for testing. Both are driven through the **same adapter interface**
(`upsertMarker` / `removeMarker` / `fitBounds` / `focusOn` / `setCenter`), so the entire
app — sockets, roster, distances, pin lifecycle, auto-fit — is provider-agnostic. What you
verify on OSM is genuinely what runs on Google; only the ~150 lines behind the adapter differ.

Set `MAP_PROVIDER` in `.env`:

| Value | Behaviour |
| --- | --- |
| `auto` *(default)* | Google Maps if `GOOGLE_MAPS_API_KEY` is set, otherwise OpenStreetMap |
| `google` | Force Google Maps — the production map |
| `osm` | Force OpenStreetMap, even if a key is present |

The server prints which provider is active on boot, and the room page shows a dashed
`OPENSTREETMAP (TEST)` badge whenever you are *not* on the real map, so you can never
mistake one for the other.

To switch to Google Maps, get a key (**[SETUP-GOOGLE-CLOUD.md](SETUP-GOOGLE-CLOUD.md)**,
about 5 minutes), then:

```bash
cp .env.example .env      # paste your key into GOOGLE_MAPS_API_KEY
npm start
```

Leaflet is served from `node_modules` at `/vendor/leaflet`, not a CDN, so the test map
works offline and can't be broken by a third party.

## Testing it with two "people" on one machine

Browser geolocation only works on `localhost` or over HTTPS, so both sides must use
`http://localhost:3000` (not `127.0.0.1`, not your LAN IP).

1. Tab A: open <http://localhost:3000>, enter a name, click **Start a meetup**.
2. Click **Send my location**, allow the permission prompt. Your blue pin appears.
3. Copy the room URL from the address bar.
4. Tab B: open that URL in a **different browser or a private/incognito window** — identity
   is per-tab-session, and a private window guarantees a separate one.
5. Tab B: opening a room link with no remembered name shows the **Who's joining?** dialog —
   type a name and join. The name is kept in `localStorage`, so this browser is not asked
   again; **Rename** in the panel changes it later.
6. Tab B: click **Send my location**. A second, differently-coloured pin appears **in both
   tabs**, and the panel shows the distance between you.

Both tabs will report the same real coordinates (same device), so the two pins land on top
of each other. To see them separated, use Chrome DevTools → ⋮ → **More tools → Sensors** →
**Location** and pick a different city for one tab.

## How it works

```
browser ──HTTP──▶ Express ── serves /public, /api/config, /api/rooms
   │
   └──WebSocket──▶ ws server (/ws?room=…&name=…)
                     │
                     └─ in-memory Map of rooms → members {lat,lng,accuracy,updatedAt}
                        any location update re-broadcasts the room to everyone in it
```

- `server.js` — Express + `ws`. Rooms live in memory; empty rooms are swept after 30
  minutes. A 30s ping/pong heartbeat removes dead connections so stale pins disappear.
- `public/app.js` — holds the socket, takes a local-only position fix on load, runs
  `navigator.geolocation.watchPosition` while you are sharing, and drives the map through
  the provider adapter. Knows nothing about Google or Leaflet specifically.
- `public/map-google.js` / `public/map-osm.js` — the two adapters.
- `public/pin.js` — the pin DOM, shared by both so a pin looks identical either way.
- The API key is served from `/api/config` rather than baked into HTML, so the only copy on
  disk is your gitignored `.env`. It is withheld entirely when the OSM provider is active.

## Behaviour worth knowing

- **The map opens where you are.** On load the room takes a single coarse position fix and
  centres the map on it, drawing a faded "You (not shared)" pin. That fix never leaves the
  browser — it exists so the map is not a blank world view. If the permission is denied or
  unavailable, the app stays silent and shows the world view.
- **Sharing is opt-in and revocable.** Nothing is transmitted until you press the button;
  pressing **Stop sharing** wipes your coordinates from the server and removes your pin for
  everyone — locally the faded pin comes back so the map keeps its place.
- **Live, not one-shot.** While sharing, your pin follows you.
- **Anyone with the link can join.** Room IDs are random 8-character codes, so they are not
  guessable, but they are not secret either — treat the link like a password.
- **Nothing is persisted.** Restarting the server clears every room.

## Deploying later

The server is a plain Node HTTP server, so Render / Railway / Fly all work with `npm start`.
Two things to remember:

1. Add your production origin to the API key's referrer restrictions.
2. HTTPS is mandatory in production — browsers refuse geolocation otherwise. Those hosts
   terminate TLS for you.

For multiple server instances you would need to move room state out of memory (Redis
pub/sub); at MVP scale a single instance is fine.
