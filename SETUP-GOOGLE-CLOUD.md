# Getting your Google Maps API key

You need exactly one thing from Google: a **Maps JavaScript API key**. This takes about 5
minutes. Everything below happens at <https://console.cloud.google.com>.

---

## 1. Create a project

1. Go to <https://console.cloud.google.com/projectcreate>.
2. Name it something like `meet-up-mvp`. Leave the organisation/location as-is.
3. Click **Create**, then make sure that project is selected in the picker at the top of
   the page.

## 2. Enable billing

Google requires a billing account on the project even though you almost certainly will not
be charged — Maps includes a recurring **$200/month free credit**, and local development
uses a tiny fraction of it.

1. Go to <https://console.cloud.google.com/billing>.
2. Link a billing account to your project (create one with a card if you have none).

> Not ready to attach a card? You don't have to stop — the app already runs on
> OpenStreetMap + Leaflet with no key and no billing. Just `npm start` and everything
> except the Google tiles themselves works. Come back to this document when you want the
> real map.

## 3. Enable the Maps JavaScript API

1. Go to <https://console.cloud.google.com/apis/library/maps-backend.googleapis.com>.
2. Click **Enable**.

That is the only API this app calls. You do **not** need Places, Directions, Geocoding, or
the Routes API.

## 4. Create the API key

1. Go to <https://console.cloud.google.com/apis/credentials>.
2. Click **+ Create credentials → API key**.
3. Copy the key that appears.

## 5. Restrict the key (do this — an unrestricted key can be abused)

Still on the Credentials page, click your new key to edit it.

**Application restrictions** → *Websites*. Add these referrers:

```
http://localhost:3000/*
http://127.0.0.1:3000/*
```

⚠ **The port matters.** These entries only cover port 3000. If you run the server on a
different port (say `PORT=3100` because something else already owns 3000), add
`http://localhost:3100/*` too, or Google will reject the key with
`RefererNotAllowedMapError`. The server prints the URL it bound on boot — match that.

Add your production domain later when you deploy.

**API restrictions** → *Restrict key* → tick **Maps JavaScript API** only.

Click **Save**. Restrictions can take up to 5 minutes to take effect.

## 6. Put the key in the app

In the project folder:

```bash
cp .env.example .env
```

Then open `.env` and paste your key:

```
GOOGLE_MAPS_API_KEY=AIzaSy...your-key-here
MAP_PROVIDER=auto
```

Restart the server (`npm start`). With `MAP_PROVIDER=auto` the presence of a key flips the
app from OpenStreetMap to Google Maps automatically; the boot log states which is active,
and the `OPENSTREETMAP (TEST)` badge on the room page disappears once you're on Google.

To go back to the keyless test map at any time, set `MAP_PROVIDER=osm`.

---

## Optional: a custom Map ID

The app defaults to `DEMO_MAP_ID`, Google's development Map ID. It works immediately but
ignores custom styling. To use your own colours:

1. Go to <https://console.cloud.google.com/google/maps-apis/studio/maps>.
2. **Create Map ID** → Map type **JavaScript** → **Vector**.
3. Copy the ID into `.env` as `GOOGLE_MAPS_MAP_ID=`.

---

## Troubleshooting

| What you see | What it means |
| --- | --- |
| Grey map, console says `ApiNotActivatedMapError` | Step 3 was skipped — enable the Maps JavaScript API. |
| Console says `RefererNotAllowedMapError` | Your URL isn't in the referrer list from step 5. Note that `localhost` and `127.0.0.1` count as different referrers. |
| Console says `BillingNotEnabledMapError` | Step 2 was skipped. |
| Banner: "Google rejected the API key" | Any of the above — check the browser console for the exact code. |
| `"For development purposes only"` watermark | Billing isn't linked, or the key is invalid. |
| Still seeing the OSM test map | `MAP_PROVIDER` is set to `osm`, or the key didn't load — check the boot log. |

Whatever goes wrong here, you are never blocked: set `MAP_PROVIDER=osm` and keep building
on the test map while you sort the key out.

## Cost control (recommended)

At <https://console.cloud.google.com/billing/budgets>, create a budget of e.g. $1 with an
alert at 100%. You will get an email long before anything unexpected happens.
