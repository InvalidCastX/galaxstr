<script setup>
import { ref, shallowRef, reactive, computed, onBeforeUnmount, onMounted, provide } from 'vue'
import GalaxyView from './components/GalaxyView.vue'
import ProfilePopup from './components/ProfilePopup.vue'
import SearchBox from './components/SearchBox.vue'
import RelaySettings from './components/RelaySettings.vue'
import { RelayPool, DEFAULT_RELAYS, resolveToHex, hexToNpub } from './nostr.js'
import { buildGalaxy, detectConstellations } from './galaxy.js'
import { LayoutClient } from './layoutClient.js'
import { cleanRelays, relaysFromSearch, relaysToSearch, loadStoredRelays, saveStoredRelays } from './relays.js'

// --- runtime configuration ---
// Loaded from public/config.json at startup so relays, the NostrCard
// domain, and load limits can be changed without a rebuild. These are
// the fallback defaults if that fetch fails for any reason (offline,
// missing file, etc).
const config = reactive({
  relays: DEFAULT_RELAYS,
  nostrCardBaseUrl: 'https://cardstr.pages.dev/#/p/',
  maxProfiles: 500,
  maxEvents: 5000,
  maxNodes: 1200,
  initialProfileLimit: 120,
  initialNoteLimit: 400,
  initialRepostLimit: 150,
  initialReactionLimit: 250,
  loadMoreStep: 120
})
const configLoaded = ref(false)

// --- relay list ---
// Precedence: ?relay= in the URL  >  the user's saved choice  >  config.json.
// The active list is mirrored into the address bar so a link carries it.
function safeStorage() {
  try {
    return window.localStorage
  } catch {
    return null
  }
}
const urlRelays = typeof location !== 'undefined' ? relaysFromSearch(location.search) : []
const storedRelays = urlRelays.length ? [] : loadStoredRelays(safeStorage())
const activeRelays = ref(urlRelays.length ? urlRelays : storedRelays.length ? storedRelays : [...DEFAULT_RELAYS])
const defaultRelays = ref([...DEFAULT_RELAYS])
const relayStatus = ref({})
const showSettings = ref(false)

function syncUrl() {
  try {
    const search = relaysToSearch(activeRelays.value, location.search)
    history.replaceState(history.state, '', location.pathname + search + location.hash)
  } catch {
    /* sandboxed iframe etc. — the setting still works, it just isn't in the URL */
  }
}

const isCoarsePointer = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches
// Phones get a smaller star budget than desktops.
const effectiveMaxNodes = () => (isCoarsePointer ? Math.min(config.maxNodes, 600) : config.maxNodes)

// --- avatar data mode ---
// 'saver' (default) fetches small resized avatars; 'full' loads original
// images as-is; 'off' skips avatars entirely and shows the spark icon.
// If the device/browser tells us the person is on a constrained or
// data-saver connection, start even more conservatively.
const nav = typeof navigator !== 'undefined' ? navigator : null
const conn = nav?.connection || nav?.mozConnection || nav?.webkitConnection
const startInOff = !!(conn?.saveData || (conn?.effectiveType && /2g/.test(conn.effectiveType)))
const dataMode = ref(startInOff ? 'off' : 'saver')
provide('dataMode', dataMode)
const dataModeLabel = computed(
  () => ({ saver: 'Data saver', off: 'Images off', full: 'Full images' })[dataMode.value]
)
function cycleDataMode() {
  dataMode.value = dataMode.value === 'saver' ? 'off' : dataMode.value === 'off' ? 'full' : 'saver'
}

async function loadConfig() {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}config.json`)
    if (res.ok) {
      const data = await res.json()
      Object.assign(config, data)
    }
  } catch {
    // Fall back silently to the defaults above — this is read-only
    // convenience config, never a hard dependency.
  } finally {
    configLoaded.value = true
    const fromConfig = cleanRelays(config.relays)
    defaultRelays.value = fromConfig.length ? fromConfig : [...DEFAULT_RELAYS]
    // nothing from the URL or a saved choice: use the deployment's defaults
    if (!urlRelays.length && !storedRelays.length) activeRelays.value = [...defaultRelays.value]
    syncUrl()
  }
}
onMounted(loadConfig)

// Loading is staged/lazy: a small first batch renders fast, and further
// batches only load when the person asks for more — never one huge
// up-front pull that hangs the tab while hundreds of accounts arrive.

const screen = ref('landing') // 'landing' | 'galaxy'
const connection = reactive({ state: 'idle', lastUpdate: null, error: null }) // idle | connecting | connected | failed
const loadedProfileCount = ref(0)
const canLoadMore = computed(() => loadedProfileCount.value < config.maxProfiles && eventCount < config.maxEvents)
const loadingMore = ref(false)

const rawProfiles = new Map() // pubkey -> kind0 event
const rawNotes = []
const rawReposts = []
const rawReactions = []
let eventCount = 0
let oldestNoteSeen = null // for paging "load more" further back in time
let oldestProfileSeen = null
let positionCache = new Map() // id -> {x, y} — carried across rebuilds so settled stars stay put

// shallowRef: these hold thousands of plain objects that are only ever
// replaced wholesale. A deep ref() would wrap every node (and its Maps) and
// every edge in a reactive Proxy, making each property read in the render
// path far slower for no benefit.
const nodes = shallowRef([])
const edges = shallowRef([])
const constellations = shallowRef([])

const selectedNode = shallowRef(null)
const focusToken = reactive({ id: null, nonce: 0 })
const orbitPubkey = ref(null)
const orbitInput = ref('')
const orbitError = ref('')
const showConstellations = ref(false)

let pool = null
let layoutClient = null
let disposed = false

// --- rebuild scheduling ---
// Trailing debounce (so a burst of events becomes one rebuild) with a max
// wait (so a steady trickle can't postpone the first render forever), and
// never more than one rebuild in flight.
let rebuildTimer = null
let firstPendingAt = 0
let rebuilding = false
let rebuildQueued = false

function scheduleRebuild() {
  const now = performance.now()
  if (!firstPendingAt) firstPendingAt = now
  clearTimeout(rebuildTimer)
  const base = nodes.value.length ? 900 : 500
  const wait = Math.max(0, Math.min(base, firstPendingAt + 3000 - now))
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null
    firstPendingAt = 0
    rebuild()
  }, wait)
}

async function rebuild() {
  if (disposed) return
  if (rebuilding) {
    rebuildQueued = true
    return
  }
  rebuilding = true
  const myEpoch = epoch
  try {
    const { nodes: n, edges: e } = buildGalaxy(
      { profiles: rawProfiles, notes: rawNotes, reposts: rawReposts, reactions: rawReactions },
      { maxNodes: effectiveMaxNodes() }
    )

    // Layout runs in a Web Worker: only ids/activity/links go over, a flat
    // Float32Array of positions comes back. The UI stays interactive.
    layoutClient = layoutClient || new LayoutClient()
    const xy = await layoutClient.run(
      n.map((node) => ({ id: node.id, activity: node.activity })),
      e.map((edge) => ({ source: edge.source, target: edge.target, weight: edge.weight })),
      positionCache
    )
    if (disposed || myEpoch !== epoch) return

    const nextCache = new Map()
    for (let i = 0; i < n.length; i++) {
      n[i].x = xy[i * 2]
      n[i].y = xy[i * 2 + 1]
      nextCache.set(n[i].id, { x: n[i].x, y: n[i].y })
    }
    positionCache = nextCache

    nodes.value = n
    edges.value = e
    constellations.value = detectConstellations(n, e)
    connection.lastUpdate = Date.now()
    loadedProfileCount.value = rawProfiles.size
    loadingMore.value = false
    // keep selection pointing at the freshest copy of the same node
    if (selectedNode.value) {
      const fresh = n.find((x) => x.id === selectedNode.value.id)
      if (fresh) selectedNode.value = fresh
    }
  } finally {
    rebuilding = false
    if (rebuildQueued) {
      rebuildQueued = false
      scheduleRebuild()
    }
  }
}

// Bumped whenever the data source changes so a layout that was already in
// flight can't paint stale stars from the previous relays.
let epoch = 0

function resetAndReconnect() {
  epoch++
  pool?.closeAll()
  pool = null
  clearTimeout(rebuildTimer)
  rebuildTimer = null
  firstPendingAt = 0
  rebuildQueued = false
  rawProfiles.clear()
  rawNotes.length = 0
  rawReposts.length = 0
  rawReactions.length = 0
  eventCount = 0
  oldestNoteSeen = null
  oldestProfileSeen = null
  positionCache = new Map()
  nodes.value = []
  edges.value = []
  constellations.value = []
  selectedNode.value = null
  loadedProfileCount.value = 0
  loadingMore.value = false
  connection.lastUpdate = null
  exitOrbit()
  connectToRelays()
}

function applyRelays(list) {
  showSettings.value = false
  const next = cleanRelays(list)
  if (!next.length) return
  const changed = next.join('\n') !== activeRelays.value.join('\n')
  activeRelays.value = next
  // a list equal to the defaults needn't be "remembered" (lets future default changes through)
  saveStoredRelays(safeStorage(), next.join('\n') === defaultRelays.value.join('\n') ? null : next)
  syncUrl()
  if (changed && connection.state !== 'idle') resetAndReconnect()
}

function enterGalaxy() {
  screen.value = 'galaxy'
  if (connection.state === 'idle') connectToRelays()
}

// A "snapshot" subscription: fetch the stored events matching a filter and
// then CLOSE it. Without this, relays keep streaming every new kind 1/7
// event on the network for as long as the tab is open — each one parsed,
// de-duplicated and (until the cap) triggering another rebuild.
function snapshot(filter, onEvent) {
  const p = pool // the pool this query belongs to; a later reconnect replaces `pool`
  const eoseFrom = new Set()
  let subId = null
  const stop = () => {
    clearTimeout(timer)
    if (subId) p.close(subId)
    subId = null
  }
  const timer = setTimeout(stop, 10000) // relays that never answer
  subId = p.subscribe([filter], {
    onEvent: (event) => {
      if (pool === p) onEvent(event)
    },
    onEose: (url) => {
      eoseFrom.add(url)
      // done once every open relay has answered and none is still connecting
      if (p.allSettled && p.openUrls.every((u) => eoseFrom.has(u))) stop()
    }
  })
}

function accepting() {
  return eventCount < config.maxEvents
}
function countEvent() {
  eventCount++
  if (eventCount >= config.maxEvents) pool?.closeSubs() // hard stop: nothing more can be used
  scheduleRebuild()
}

function onProfileEvent(event) {
  if (!accepting()) return
  const existing = rawProfiles.get(event.pubkey)
  if (!existing || existing.created_at < event.created_at) {
    rawProfiles.set(event.pubkey, event)
    oldestProfileSeen = oldestProfileSeen ? Math.min(oldestProfileSeen, event.created_at) : event.created_at
    countEvent()
  }
}
function onNoteEvent(event) {
  if (!accepting()) return
  rawNotes.push(event)
  oldestNoteSeen = oldestNoteSeen ? Math.min(oldestNoteSeen, event.created_at) : event.created_at
  countEvent()
}
function onRepostEvent(event) {
  if (!accepting()) return
  rawReposts.push(event)
  countEvent()
}
function onReactionEvent(event) {
  if (!accepting()) return
  rawReactions.push(event)
  countEvent()
}

function connectToRelays() {
  connection.state = 'connecting'
  connection.error = null
  pool = new RelayPool([...activeRelays.value])
  pool.onStatusChange = (summary) => {
    relayStatus.value = { ...summary }
    const values = Object.values(summary)
    if (values.some((s) => s === 'open')) connection.state = 'connected'
    else if (values.every((s) => s === 'closed' || s === 'error')) {
      connection.state = 'failed'
      connection.error = 'Unable to reach relays'
    }
  }
  pool.connect()

  // First pass: a small, fast batch so the galaxy renders quickly.
  // Larger batches are only pulled in later, on request (see loadMore()).
  snapshot({ kinds: [0], limit: config.initialProfileLimit }, onProfileEvent)
  snapshot({ kinds: [1], limit: config.initialNoteLimit }, onNoteEvent)
  snapshot({ kinds: [6], limit: config.initialRepostLimit }, onRepostEvent)
  snapshot({ kinds: [7], limit: config.initialReactionLimit }, onReactionEvent)
}

// Pulls in the next slice of the universe — older profiles and notes —
// instead of the first load trying to swallow the whole network at once.
// Existing stars keep their settled position (see the position cache in
// rebuild()), so this only costs simulation time for what's actually new.
function loadMore() {
  if (!pool || loadingMore.value || !canLoadMore.value) return
  loadingMore.value = true

  // Both slices are paged backwards with `until`; the profile one used to
  // re-request the same newest 120 profiles every time.
  const profileFilter = { kinds: [0], limit: config.loadMoreStep }
  if (oldestProfileSeen) profileFilter.until = oldestProfileSeen - 1
  snapshot(profileFilter, onProfileEvent)

  const noteFilter = { kinds: [1], limit: config.loadMoreStep }
  if (oldestNoteSeen) noteFilter.until = oldestNoteSeen - 1
  snapshot(noteFilter, onNoteEvent)

  // Safety net: stop showing "loading" even if a relay never sends EOSE.
  setTimeout(() => (loadingMore.value = false), 6000)
}

onBeforeUnmount(() => {
  disposed = true
  pool?.closeAll()
  layoutClient?.destroy()
  clearTimeout(rebuildTimer)
})

const lastUpdateLabel = computed(() => {
  if (!connection.lastUpdate) return null
  const secs = Math.max(0, Math.round((Date.now() - connection.lastUpdate) / 1000))
  if (secs < 5) return 'just now'
  if (secs < 60) return `${secs} seconds ago`
  return `${Math.round(secs / 60)} min ago`
})

function selectStar(node) {
  selectedNode.value = node
}
function closePopup() {
  selectedNode.value = null
}
function focusOn(id) {
  focusToken.id = id
  focusToken.nonce++
}

function locateNode(node) {
  selectedNode.value = node
  focusOn(node.id)
}

// --- orbit mode ---
const orbitData = computed(() => {
  if (!orbitPubkey.value) return null
  const center = nodes.value.find((n) => n.id === orbitPubkey.value)
  if (!center) return null

  const adjacency = new Map()
  for (const n of nodes.value) adjacency.set(n.id, new Set())
  for (const e of edges.value) {
    const s = e.source?.id || e.source
    const t = e.target?.id || e.target
    if (adjacency.has(s) && adjacency.has(t)) {
      adjacency.get(s).add(t)
      adjacency.get(t).add(s)
    }
  }

  const distance = new Map([[center.id, 0]])
  let frontier = [center.id]
  for (let d = 1; d <= 3; d++) {
    const next = []
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) || []) {
        if (!distance.has(neighbor)) {
          distance.set(neighbor, d)
          next.push(neighbor)
        }
      }
    }
    frontier = next
  }

  const byId = new Map(nodes.value.map((n) => [n.id, n]))
  const byDistance = { 1: [], 2: [], 3: [] }
  for (const [id, d] of distance) {
    if (d >= 1 && d <= 3 && byId.has(id)) byDistance[d].push(byId.get(id))
  }
  return { center, byDistance, visibleIds: new Set(distance.keys()) }
})

const orbitFilteredNodes = computed(() => {
  if (!orbitData.value) return nodes.value
  return nodes.value.filter((n) => orbitData.value.visibleIds.has(n.id))
})
const orbitFilteredEdges = computed(() => {
  if (!orbitData.value) return edges.value
  return edges.value.filter((e) => {
    const s = e.source?.id || e.source
    const t = e.target?.id || e.target
    return orbitData.value.visibleIds.has(s) && orbitData.value.visibleIds.has(t)
  })
})

function enterOrbit() {
  orbitError.value = ''
  const hex = resolveToHex(orbitInput.value)
  if (!hex) {
    orbitError.value = 'Enter a valid npub, nprofile, or hex pubkey'
    return
  }
  if (!nodes.value.find((n) => n.id === hex)) {
    orbitError.value = 'That identity has no observed activity in the current window'
    return
  }
  orbitPubkey.value = hex
  focusOn(hex)
}
function exitOrbit() {
  orbitPubkey.value = null
  orbitInput.value = ''
  orbitError.value = ''
}

function displayNodes() {
  return orbitPubkey.value ? orbitFilteredNodes.value : nodes.value
}
function displayEdges() {
  return orbitPubkey.value ? orbitFilteredEdges.value : edges.value
}
</script>

<template>
  <!-- LANDING -->
  <div v-if="screen === 'landing'" class="landing">
    <div class="landing__stars" aria-hidden="true"></div>
    <div class="landing__grid">
      <div class="landing__content">
        <p class="landing__eyebrow">A telescope for the Nostr social universe</p>
        <h1 class="landing__title">Galaxstr</h1>
        <p class="landing__body">
          Every account becomes a star. Every reply, mention, and repost becomes a gravitational link between
          them. Explore the shape of the Nostr network as it actually forms — not as a feed.
        </p>
        <button class="landing__cta" @click="enterGalaxy">
          <i class="fa-solid fa-circle-nodes" aria-hidden="true"></i>
          Enter Galaxy
        </button>
        <ul class="landing__notes">
          <li><i class="fa-solid fa-door-open" aria-hidden="true"></i> No account required</li>
          <li><i class="fa-solid fa-shield-halved" aria-hidden="true"></i> No private keys, ever</li>
          <li><i class="fa-solid fa-satellite-dish" aria-hidden="true"></i> Public relay data only</li>
          <li><i class="fa-solid fa-infinity" aria-hidden="true"></i> Free to explore, always</li>
        </ul>
        <button class="landing__relays" @click="showSettings = true" aria-label="Relay settings">
          <i class="fa-solid fa-gear" aria-hidden="true"></i> Relays ({{ activeRelays.length }})
        </button>
      </div>

      <div class="landing__orbit" aria-hidden="true">
        <svg viewBox="0 0 320 320" class="landing__orbit-svg" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <filter id="orbitGlow" x="-120%" y="-120%" width="340%" height="340%">
              <feGaussianBlur stdDeviation="4" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <g class="orbit-spin">
            <ellipse cx="160" cy="160" rx="130" ry="48" class="orbit-ring orbit-ring--a" />
            <ellipse cx="160" cy="160" rx="48" ry="130" class="orbit-ring orbit-ring--b" transform="rotate(30 160 160)" />
            <ellipse cx="160" cy="160" rx="96" ry="96" class="orbit-ring orbit-ring--c" />
            <circle cx="285" cy="140" r="4.5" class="orbit-star orbit-star--gold" filter="url(#orbitGlow)" />
            <circle cx="60" cy="205" r="3.5" class="orbit-star orbit-star--green" filter="url(#orbitGlow)" />
            <circle cx="205" cy="55" r="3" class="orbit-star orbit-star--blue" filter="url(#orbitGlow)" />
            <circle cx="95" cy="90" r="2.6" class="orbit-star orbit-star--purple" filter="url(#orbitGlow)" />
          </g>
          <circle cx="160" cy="160" r="18" class="orbit-core" filter="url(#orbitGlow)" />
          <circle cx="160" cy="160" r="6" class="orbit-core-dot" />
        </svg>
      </div>
    </div>
  </div>

  <!-- GALAXY -->
  <div v-else class="app">
    <header class="topbar">
      <div class="topbar__brand">
        <span class="topbar__title">Galaxstr</span>
        <span class="topbar__status" :class="`status--${connection.state}`">
          <span class="dot"></span>
          <template v-if="connection.state === 'connected'">Connected</template>
          <template v-else-if="connection.state === 'connecting'">Connecting to Nostr universe…</template>
          <template v-else-if="connection.state === 'failed'">Unable to reach relays</template>
          <template v-else>Idle</template>
        </span>
      </div>
      <SearchBox :nodes="nodes" @locate="locateNode" />
    </header>

    <GalaxyView
      :nodes="displayNodes()"
      :edges="displayEdges()"
      :selected-id="selectedNode?.id || null"
      :focus-token="focusToken"
      @select-star="selectStar"
      @background-click="closePopup"
    />

    <!-- orbit mode panel -->
    <div class="orbit-panel" :class="{ 'orbit-panel--yield': selectedNode }">
      <template v-if="!orbitPubkey">
        <label class="orbit-panel__label">Your Orbit</label>
        <div class="orbit-panel__row">
          <input v-model="orbitInput" placeholder="npub1…" class="orbit-panel__input" @keyup.enter="enterOrbit" />
          <button class="orbit-panel__go" @click="enterOrbit">Go</button>
        </div>
        <p v-if="orbitError" class="orbit-panel__error">{{ orbitError }}</p>
      </template>
      <template v-else>
        <div class="orbit-panel__active">
          <div>
            <p class="orbit-panel__label">Your Orbit</p>
            <p class="orbit-panel__center">{{ orbitData?.center?.name || hexToNpub(orbitPubkey)?.slice(0, 14) }}</p>
          </div>
          <button class="orbit-panel__exit" @click="exitOrbit">Exit</button>
        </div>
        <dl class="orbit-panel__distances">
          <dt>Distance 1</dt>
          <dd>{{ orbitData?.byDistance[1]?.length || 0 }} direct interactions</dd>
          <dt>Distance 2</dt>
          <dd>{{ orbitData?.byDistance[2]?.length || 0 }} connected through others</dd>
          <dt>Distance 3</dt>
          <dd>{{ orbitData?.byDistance[3]?.length || 0 }} wider community</dd>
        </dl>
      </template>
    </div>

    <!-- status / constellations footer -->
    <div class="footer-row">
      <div class="status-chip">
        <span class="dot" :class="`dot--${connection.state}`"></span>
        <span v-if="connection.state === 'connected'">
          {{ nodes.length }} stars observed<template v-if="lastUpdateLabel"> · updated {{ lastUpdateLabel }}</template>
        </span>
        <span v-else-if="connection.state === 'connecting'">Connecting to Nostr universe…</span>
        <span v-else-if="connection.state === 'failed'">Unable to reach relays</span>
      </div>
      <button v-if="constellations.length" class="constellation-toggle" @click="showConstellations = !showConstellations">
        {{ constellations.length }} possible cluster{{ constellations.length === 1 ? '' : 's' }}
      </button>
      <button
        v-if="connection.state === 'connected' && canLoadMore"
        class="constellation-toggle"
        :disabled="loadingMore"
        @click="loadMore"
      >
        {{ loadingMore ? 'Loading…' : 'Load more stars' }}
      </button>
      <button class="constellation-toggle" @click="showSettings = true" title="Add or remove relays">
        Relays ({{ activeRelays.length }})
      </button>
      <button
        class="constellation-toggle"
        @click="cycleDataMode"
        title="Cycles avatar quality: data saver → images off → full quality"
      >
        {{ dataModeLabel }}
      </button>
    </div>

    <div v-if="showConstellations" class="constellation-panel scroll-thin">
      <button class="constellation-panel__close" @click="showConstellations = false" aria-label="Close">✕</button>
      <h4>Constellations</h4>
      <ul>
        <li v-for="(c, i) in constellations" :key="i">
          <button
            class="constellation-item"
            @click="
              () => {
                focusOn(c.members[0].id)
                showConstellations = false
              }
            "
          >
            <span class="constellation-item__label">{{ c.label }}</span>
            <span class="constellation-item__size">{{ c.size }} members</span>
          </button>
        </li>
      </ul>
    </div>

    <!-- selected star popup -->
    <div v-if="selectedNode" class="popup-anchor">
      <ProfilePopup
        :node="selectedNode"
        :nostr-card-base-url="config.nostrCardBaseUrl"
        :relays="activeRelays"
        @close="closePopup"
      />
    </div>
  </div>

  <RelaySettings
    v-if="showSettings"
    :relays="activeRelays"
    :defaults="defaultRelays"
    :status="relayStatus"
    @apply="applyRelays"
    @close="showSettings = false"
  />
</template>

<style scoped>
/* ---------- landing ---------- */
.landing {
  position: relative;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  padding: 24px;
}
.landing__stars {
  position: absolute;
  inset: 0;
  background-image: radial-gradient(1.5px 1.5px at 20% 30%, rgba(255, 255, 255, 0.5) 50%, transparent),
    radial-gradient(1.5px 1.5px at 70% 60%, rgba(255, 255, 255, 0.4) 50%, transparent),
    radial-gradient(1px 1px at 40% 80%, rgba(255, 255, 255, 0.35) 50%, transparent),
    radial-gradient(1.5px 1.5px at 85% 20%, rgba(255, 255, 255, 0.45) 50%, transparent),
    radial-gradient(1px 1px at 60% 15%, rgba(255, 255, 255, 0.3) 50%, transparent),
    radial-gradient(ellipse at 50% 30%, rgba(120, 100, 200, 0.16), transparent 60%);
  background-size: cover;
}
.landing__grid {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: 1fr;
  align-items: center;
  justify-items: center;
  gap: 8px;
  width: 100%;
  max-width: 980px;
}
.landing__content {
  max-width: 480px;
  text-align: center;
}
.landing__eyebrow {
  color: var(--c-purple);
  font-size: 13px;
  margin: 0 0 12px;
}
.landing__title {
  font-family: var(--font-display);
  font-size: clamp(42px, 8vw, 68px);
  font-weight: 500;
  line-height: 1.05;
  margin: 0 0 18px;
  letter-spacing: -0.02em;
}
.landing__body {
  color: var(--dim);
  line-height: 1.65;
  font-size: 15.5px;
  max-width: 42ch;
  margin: 0 auto 32px;
}
.landing__relays {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  background: var(--bg-panel);
  border: 1px solid var(--hairline);
  color: var(--dim);
  border-radius: 999px;
  padding: 7px 13px;
  font-size: 12px;
  margin-top: 20px;
}
.landing__relays:hover {
  color: var(--star-white);
}
.landing__cta {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  background: var(--star-white);
  color: var(--bg-void);
  border: none;
  border-radius: 999px;
  padding: 14px 30px;
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 30px;
  transition: transform 0.15s ease;
}
.landing__cta:hover {
  transform: translateY(-1px);
}
.landing__cta i {
  font-size: 13px;
  color: var(--c-purple);
}
.landing__notes {
  list-style: none;
  padding: 0;
  margin: 0;
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  color: var(--dim);
  font-size: 13px;
}
.landing__notes li {
  display: flex;
  align-items: center;
  gap: 10px;
}
.landing__notes i {
  width: 15px;
  text-align: center;
  color: var(--c-purple);
  font-size: 12.5px;
}

/* ---------- orbit illustration ---------- */
.landing__orbit {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  padding: 8px 0 24px;
}
.landing__orbit-svg {
  width: min(300px, 62vw);
  height: auto;
  overflow: visible;
}
.orbit-ring {
  fill: none;
  stroke-width: 1;
}
.orbit-ring--a {
  stroke: rgba(155, 140, 255, 0.38);
}
.orbit-ring--b {
  stroke: rgba(110, 168, 254, 0.3);
}
.orbit-ring--c {
  stroke: rgba(242, 193, 78, 0.2);
}
.orbit-star--gold {
  fill: var(--c-gold);
}
.orbit-star--green {
  fill: var(--c-green);
}
.orbit-star--blue {
  fill: var(--c-blue);
}
.orbit-star--purple {
  fill: var(--c-purple);
}
.orbit-core {
  fill: var(--c-purple);
  opacity: 0.85;
}
.orbit-core-dot {
  fill: var(--star-white);
}
.orbit-spin {
  transform-origin: 160px 160px;
  animation: orbit-spin 140s linear infinite;
}
@keyframes orbit-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (min-width: 860px) {
  .landing__grid {
    grid-template-columns: minmax(0, 460px) 1fr;
    justify-items: stretch;
    gap: 48px;
    text-align: left;
  }
  .landing__content {
    max-width: none;
    text-align: left;
  }
  .landing__body {
    margin: 0 0 32px;
  }
  .landing__notes {
    align-items: flex-start;
  }
  .landing__orbit-svg {
    width: min(380px, 100%);
  }
}

/* ---------- galaxy screen ---------- */
.app {
  position: relative;
  height: 100%;
  overflow: hidden;
}

.topbar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: calc(14px + env(safe-area-inset-top)) calc(16px + env(safe-area-inset-right)) 14px
    calc(16px + env(safe-area-inset-left));
  background: linear-gradient(to bottom, rgba(5, 6, 12, 0.85), transparent);
}
.topbar__brand {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.topbar__title {
  font-family: var(--font-display);
  font-size: 17px;
  white-space: nowrap;
}
.topbar__status {
  display: none;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--dim);
}
@media (min-width: 640px) {
  .topbar__status {
    display: flex;
  }
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dim);
}
.status--connected .dot,
.dot--connected {
  background: var(--c-green);
  box-shadow: 0 0 6px var(--c-green);
}
.status--connecting .dot,
.dot--connecting {
  background: var(--c-blue);
}
.status--failed .dot,
.dot--failed {
  background: var(--c-red);
}

.orbit-panel {
  position: absolute;
  left: calc(16px + env(safe-area-inset-left));
  bottom: calc(16px + env(safe-area-inset-bottom));
  z-index: 5;
  width: min(260px, 50vw);
  background: var(--bg-panel);
  backdrop-filter: blur(10px);
  border: 1px solid var(--hairline);
  border-radius: 12px;
  padding: 12px;
  font-size: 12.5px;
}
@media (max-width: 639px) {
  /* On a small phone screen, an open star popup and the orbit panel both
     want the bottom band of the viewport — the popup is the thing the
     person just asked for, so it wins and the orbit panel steps aside
     rather than overlapping it. */
  .orbit-panel--yield {
    display: none;
  }
}
.orbit-panel__label {
  margin: 0 0 6px;
  color: var(--dim);
  font-size: 11.5px;
}
.orbit-panel__row {
  display: flex;
  gap: 6px;
}
.orbit-panel__input {
  flex: 1;
  min-width: 0;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--hairline);
  border-radius: 7px;
  padding: 7px 8px;
  color: var(--star-white);
  /* Same iOS Safari auto-zoom-on-focus issue as the search input. */
  font-size: 16px;
  font-family: var(--font-ui);
}
.orbit-panel__go {
  background: var(--c-purple);
  color: #0d0820;
  border: none;
  border-radius: 7px;
  padding: 0 12px;
  font-weight: 600;
  font-size: 12px;
}
.orbit-panel__error {
  margin: 6px 0 0;
  color: var(--c-red);
  font-size: 11px;
}
.orbit-panel__active {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
}
.orbit-panel__center {
  margin: 0;
  font-size: 13px;
}
.orbit-panel__exit {
  background: none;
  border: 1px solid var(--hairline);
  color: var(--dim);
  border-radius: 6px;
  padding: 3px 8px;
  font-size: 11px;
}
.orbit-panel__distances {
  margin: 10px 0 0;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 3px 8px;
}
.orbit-panel__distances dt {
  color: var(--dim);
}
.orbit-panel__distances dd {
  margin: 0;
}

.footer-row {
  position: absolute;
  right: calc(16px + env(safe-area-inset-right));
  bottom: calc(16px + env(safe-area-inset-bottom));
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}
.status-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--bg-panel);
  backdrop-filter: blur(10px);
  border: 1px solid var(--hairline);
  border-radius: 999px;
  padding: 7px 12px;
  font-size: 11.5px;
  color: var(--dim);
}
.constellation-toggle {
  background: var(--bg-panel);
  border: 1px solid var(--hairline);
  color: var(--star-white);
  border-radius: 999px;
  padding: 7px 12px;
  font-size: 11.5px;
}
.constellation-toggle:disabled {
  opacity: 0.5;
  cursor: default;
}

.constellation-panel {
  position: absolute;
  right: calc(16px + env(safe-area-inset-right));
  bottom: 64px;
  z-index: 6;
  width: min(260px, 60vw);
  max-height: 300px;
  overflow-y: auto;
  background: var(--bg-panel-solid);
  border: 1px solid var(--hairline);
  border-radius: 12px;
  padding: 14px;
}
.constellation-panel h4 {
  margin: 0 0 8px;
  font-size: 13px;
}
.constellation-panel__close {
  position: absolute;
  top: 8px;
  right: 8px;
  background: none;
  border: none;
  color: var(--dim);
}
.constellation-panel ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.constellation-item {
  width: 100%;
  text-align: left;
  background: rgba(255, 255, 255, 0.04);
  border: none;
  border-radius: 8px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.constellation-item__label {
  font-size: 12px;
  color: var(--c-green);
}
.constellation-item__size {
  font-size: 10.5px;
  color: var(--dim);
}

.popup-anchor {
  position: absolute;
  left: 50%;
  bottom: calc(16px + env(safe-area-inset-bottom));
  transform: translateX(-50%);
  z-index: 10;
}
@media (min-width: 640px) {
  .popup-anchor {
    left: auto;
    right: calc(16px + env(safe-area-inset-right));
    top: 70px;
    bottom: auto;
    transform: none;
  }
}
</style>
