# Galaxstr

Galaxstr (formerly Nostr Galaxy Map) is a visual explorer of the Nostr / BCHNostr ecosystem. Users appear as glowing
stars, observed interactions (replies, mentions, reposts, reactions, shared
topics) appear as gravitational links, and loosely-connected groups surface
as "possible" constellations.

Companion apps:
- **BCHNostr LiveGrid** — network activity observatory
- **NostrCards** — identity/profile cards (this app links out to
  `https://cardstr.pages.dev/#/p/<npub>?relays=…` when you click a star,
  passing along the relays you're currently using)

This is a read-only explorer. It never asks for a private key, seed phrase,
or wallet connection — it only reads public events from relays over
WebSocket.

## Stack

- Vite + Vue 3 (`<script setup>`), plain CSS — no TypeScript, no Tailwind
- `d3-force` for the galaxy layout simulation (in a Web Worker)
- A single `<canvas>` 2D renderer for stars and links
- A small hand-rolled NIP-01 WebSocket client (`src/nostr.js`) — no other
  Nostr library dependency
- No backend, no database — everything runs client-side against public
  relays

## Getting started

```bash
npm install
npm run dev
```

Then open the printed local URL. Click **Enter Galaxy** to connect to the
default relays and start rendering real profiles and activity.

```bash
npm run build      # production build in dist/
npm run preview    # preview the production build locally
```

## Deploying to Cloudflare Pages (galaxstr.pages.dev)

Cloudflare Pages builds straight from your Git repo on every push.

1. Push this project to a GitHub (or GitLab) repo.
2. In the Cloudflare dashboard: **Workers & Pages → Create → Pages →
   Connect to Git**, pick the repo.
3. Set the **Project name** to `galaxstr` — that is what makes the URL
   `https://galaxstr.pages.dev`.
4. Build settings:
   - **Framework preset:** Vite (or None)
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
   - **Environment variable:** `NODE_VERSION` = `20`
5. **Save and Deploy.** Every later push to the production branch redeploys
   automatically; other branches get preview URLs.

Prefer the CLI? Build locally and upload `dist/`:

```bash
npm run build
npx wrangler pages deploy dist --project-name galaxstr
```

`vite.config.js` sets `base: './'`, so asset paths work from the root domain
with no extra config. `public/config.json` is served as a static file, so you
can edit relays and limits in the deployed project without touching code.

## Embedding (iframe)

Galaxstr can skip its landing page and drop straight into the galaxy, so it
works as a tab inside another app:

```html
<iframe
  src="https://galaxstr.pages.dev/?embed=1"
  style="width:100%;height:100%;border:0"
  allow="clipboard-write"
  loading="lazy"
  title="Galaxstr"
></iframe>
```

| Param | Effect |
| --- | --- |
| `embed=1` | Skip the landing page and hide Galaxstr's own title (your app has its header) |
| `landing=0` / `skip=1` | Skip the landing page only |
| `orbit=npub1…` | Open straight into "Your Orbit" for that identity (npub, nprofile or hex). Keeps trying as more stars load |
| `relay=a&relay=b` | Use these relays (pass your host app's relays) |

Combine freely, e.g. `?embed=1&orbit=npub1…&relay=relay.damus.io`.

**Messages to the host page** (only when running inside an iframe), via `window.postMessage`:

```js
window.addEventListener('message', (e) => {
  if (e.origin !== 'https://galaxstr.pages.dev' || e.data?.source !== 'galaxstr') return
  if (e.data.type === 'ready')  { /* first stars rendered: { stars } */ }
  if (e.data.type === 'select') { /* star clicked: { pubkey, npub, name } */ }
})
```

Cloudflare Pages sets no `X-Frame-Options` by default, so embedding works out
of the box. To restrict who can embed it, add `public/_headers`:

```
/*
  Content-Security-Policy: frame-ancestors 'self' https://friendstr.pages.dev
```

## Relay settings

Click **Relays (n)** (on the landing page or in the bottom bar) to add or
remove relays. Edit the list, then **Apply & reload** — the galaxy reloads
from the new relays. Each row shows a live connection status, **Reset to
defaults** restores the list from `config.json`, and **Copy share link** gives
you a URL that opens with the same relays.

The active relays are always mirrored in the address bar:

```
https://galaxstr.pages.dev/?relay=relay.damus.io&relay=nos.lol
```

(`wss://` is implied; `ws://` is accepted for `localhost` only.) A
`?relays=a,b` comma form is also read. At startup the order of precedence is
**URL → your saved choice (localStorage) → `config.json`**. A link only
overrides the relays for that visit; your saved list changes only when you
press Apply. Limits: 1–8 relays, `wss://` only (except localhost).

## Lazy loading

The first load pulls a small batch (120 profiles, a few hundred recent
notes/reposts/reactions) so the galaxy appears fast. A **"Load more stars"**
control (bottom right, once connected) pulls in the next slice — older
profiles, and notes paged further back in time via `until` — up to the
`MAX_PROFILES` / `MAX_EVENTS` ceiling. Nothing pulls in the whole network
up front.

Performance design (what keeps hundreds of accounts smooth):

- **Canvas renderer** — `src/renderer.js` draws every star and link on one
  `<canvas>` (cached glow sprites, batched link strokes, level-of-detail by
  on-screen size, render-on-demand). The old version mounted ~6 DOM
  elements per star with blur filters, which is what overwhelmed
  browsers. Pan/zoom/rotate only mutate a plain camera object and repaint
  once per animation frame — no Vue reactivity, no vdom diffing.
- **Lazy avatars** — avatars are fetched only for stars that are on screen
  *and* large enough to show a face, at most 6 at a time, then kept as small
  pre-clipped sprites in an LRU. Failed images are never retried.
- **Layout in a Web Worker** — `src/layout.worker.js` runs the d3-force
  simulation off the main thread (falls back to the main thread if Workers
  are unavailable). Only ids/links go in and a `Float32Array` of positions
  comes back.
- **Warm-started layout** — `computeLayout` *pins* each star's previous
  position across rebuilds (d3's `fx`/`fy`), so settled stars hold still and
  only genuinely new stars are simulated.
- **Bounded graph** — notes that tag more than 8 accounts are ignored for
  links (mention-spam), ghost accounts are dropped, and the star set is
  trimmed to `maxNodes` (600 on touch devices) by activity/links/profile.
- **Snapshot subscriptions** — each relay query is closed on EOSE instead of
  streaming the live firehose forever; everything stops at `maxEvents`.
  De-duplication is per subscription, so memory is released when it closes.
- **Cheap state** — graph state lives in `shallowRef`s (no deep Proxy
  wrapping), and rebuilds are debounced with a max-wait and never overlap.

Run `node test/smoke.mjs` for Node-only checks of the graph pruning, camera
math, hit-testing and avatar queue.

## Mobile controls

- **Drag** with one finger to pan, **pinch** to zoom.
- **Twist with two fingers** to rotate the map (same gesture as Google/Apple
  Maps) — a small compass in the middle-right edge shows the current
  heading and resets rotation to north on tap.
- On desktop, mouse-wheel zooms; **Shift + scroll** rotates.
- Star collision spacing was widened and tap targets have a 40px minimum,
  so accounts should no longer visually overlap or be hard to hit with a
  finger.

## Configuring relays, the NostrCard domain, and limits

All of this lives in `public/config.json`, fetched at startup — so it can be
edited (or swapped per deployment) **without a rebuild**:

```json
{
  "relays": [
    "wss://relay.bchnostr.com",
    "wss://relay.nos.lol",
    "wss://relay.damus.io",
    "wss://nos.lol"
  ],
  "nostrCardBaseUrl": "https://cardstr.pages.dev/#/p/",
  "maxProfiles": 500,
  "maxEvents": 5000,
  "maxNodes": 1200,
  "initialProfileLimit": 120,
  "initialNoteLimit": 400,
  "initialRepostLimit": 150,
  "initialReactionLimit": 250,
  "loadMoreStep": 120
}
```

- `maxNodes` caps how many stars are laid out and drawn (touch devices use
  at most 600). Raise it on powerful machines, lower it if a device struggles.
- `nostrCardBaseUrl` is prepended to each user's `npub` when the "Open Full
  NostrCard" button is built, followed by `?relays=` and your active relays
  (e.g. `.../#/p/npub1...?relays=relay.bchnostr.com,nos.lol`). Update it here if
  the card app's route ever changes.
- If `config.json` is missing or fails to load (e.g. offline), the app falls
  back to the defaults baked into `src/App.vue`, so it's never a hard
  dependency.
- One relay being offline never breaks the app — each relay connects
  independently and the pool merges + de-duplicates whatever comes back.

## How the galaxy is built

1. `src/nostr.js` opens a `RelayPool` and subscribes to kind 0 (profiles),
   kind 1 (notes), kind 6 (reposts), and kind 7 (reactions).
2. `src/galaxy.js` (`buildGalaxy`) turns those raw events into stars and
   weighted links: replies and mentions inside replies are the strongest
   signal, plain mentions and reposts are medium, reactions and shared
   hashtags are the weakest. No follower-graph (kind 3) is used for the
   MVP layout, since Nostr follow lists are often incomplete.
3. `computeLayout` (`src/layout.js`, run in a Web Worker) runs a `d3-force`
   simulation (link + charge + collide forces) to position every star in 2D
   space.
4. `detectConstellations` finds connected components of the medium/strong
   edge subgraph and labels them "Possible community cluster: #topic" —
   never asserted as an official group.
5. Star color is derived only from observed data: gold = NIP-05 verified,
   green = BCH-related activity seen, blue = new (first seen < 30 days
   ago), red = inactive (no activity for 90+ days), purple = general Nostr
   activity otherwise. Star size reflects observed note/reply/reaction
   volume — never a synthetic popularity score.

## Project layout

```
src/
  App.vue              landing page, relay lifecycle, orbit mode, layout
  main.js
  style.css            design tokens (color, type)
  nostr.js             WebSocket relay pool + npub/nprofile decoding
  galaxy.js            event graph -> nodes/edges, pruning, clustering
  layout.js            force layout (pure; runs in the worker)
  layout.worker.js     Web Worker entry for layout.js
  layoutClient.js      promise wrapper + main-thread fallback
  relays.js            relay validation, URL (?relay=) + localStorage
  renderer.js          canvas drawing, camera, hit-testing, avatar cache
  components/
    GalaxyView.vue      canvas host: pointer gestures (pan/pinch/twist/tap)
    ProfilePopup.vue     mini NostrCard preview + link to the full card
    SearchBox.vue        search by name / npub / nprofile / NIP-05
    RelaySettings.vue    add/remove relays modal
public/
  config.json          default relays, NostrCard domain, load limits — edit without a rebuild
```

## Not included in this MVP

Kept out on purpose, per the build plan — architecture leaves room to add
them later without a rewrite:

- Time Travel Mode (timeline scrubber over historical state)
- Kind 3 (follow list) based relationships
- Zap (kind 9735) weighted connections
