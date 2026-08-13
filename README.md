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
                        membership changes broadcast a full roster;
                        location updates broadcast only what moved
```

Server → client frames:

| Frame | Sent when | Carries |
| --- | --- | --- |
| `welcome` | on connect | `selfId`, plus `serverNow` so the client can correct for clock skew |
| `state` | someone joins or leaves | the full participant list |
| `patch` | someone moves, renames, stops, or changes away state | `{id, patch}` — just the changed fields |

Client → server: `location`, `stop`, `rename`, and `away` / `active` (sent from
`visibilitychange`).

A `patch` is always preceded by a `state` that introduced the member, and WebSocket
delivery is ordered, so a client never has to apply a patch for someone it does not
know. Sending the whole roster on every position update instead would put a room's
traffic at O(M³) bytes/sec — 2.4 MB/s in a full 25-person room, against 0.1 MB/s now.

### Knowing when a pin has gone cold

The heartbeat cannot tell you a phone has backgrounded the tab. WebSocket ping/pong is
answered by the browser's network stack without running any page JS, so the socket
stays open and the server sees nothing — while `watchPosition` has stopped firing,
because no browser grants a web page background location. Left alone that leaves a
confident-looking pin parked where someone was ten minutes ago. Two mechanisms cover it:

- **`away`** — the page sends this from `visibilitychange`, which fires *before* the
  browser freezes it. Peers see "paused" within milliseconds.
- **staleness** — no update for 45s and the pin greys out by itself, for every case
  where the `away` never made it out (crash, discarded tab, dead radio). Clients
  re-publish their last fix every 20s, so silence is real evidence rather than just
  someone standing still, and ages are measured against `serverNow` because device
  clocks are routinely minutes off.

Either way the pin stays on the map at its last known position — greyed, dashed, and
labelled "last seen", so it reads as history rather than as live.

- `server.js` — Express + `ws`. Rooms live in memory; empty rooms are swept after 30
  minutes, counting from creation so a link that is generated but never opened is
  collected too. A 30s ping/pong heartbeat removes genuinely dead connections.
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
- **Sharing survives a reload you did not ask for.** Phones discard backgrounded tabs; if
  that happens the room reloads and picks sharing back up rather than quietly leaving you
  as a frozen pin. The flag lives in `sessionStorage` keyed by room, so it applies only to
  the same tab in the same room — closing the tab ends it.
- **A pin you cannot trust looks like one.** Background the app and your friends see your
  pin turn grey and read "paused"; if your browser dies outright it greys itself after 45
  seconds. It keeps your last known position either way, labelled "last seen".
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
