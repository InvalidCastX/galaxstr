// Node-only smoke tests for the perf-critical logic (no browser needed):
//   node test/smoke.mjs
import assert from 'node:assert/strict'
import { buildGalaxy, detectConstellations } from '../src/galaxy.js'

let failures = 0
const t = (name, fn) => {
  try { fn(); console.log('  ok  ', name) } catch (e) { failures++; console.log('  FAIL', name, '\n      ', e.message) }
}
const hex = (i) => i.toString(16).padStart(64, '0')

// ---------- graph building ----------
console.log('galaxy.js')
function synth({ profiles = 150, notes = 400, spamNotes = 0, spamTags = 60, reactions = 250 } = {}) {
  const P = new Map()
  for (let i = 0; i < profiles; i++) P.set(hex(i), { pubkey: hex(i), created_at: 1e9, content: JSON.stringify({ name: 'u' + i }) })
  const N = [], R = []
  let id = 0
  const now = Math.floor(Date.now() / 1000)
  for (let i = 0; i < notes; i++) {
    N.push({ id: 'n' + id++, pubkey: hex(i % profiles), created_at: now - i, content: 'hi #nostr', tags: [['p', hex(10000 + i)]] }) // mentions unknown accounts
  }
  for (let i = 0; i < spamNotes; i++) {
    const tags = []
    for (let k = 0; k < spamTags; k++) tags.push(['p', hex(50000 + i * spamTags + k)])
    N.push({ id: 'n' + id++, pubkey: hex(i % profiles), created_at: now, content: 'gm', tags })
  }
  for (let i = 0; i < reactions; i++) R.push({ id: 'r' + id++, pubkey: hex(20000 + i), created_at: now, tags: [] }) // reaction ghosts
  return { profiles: P, notes: N, reactions: R }
}

t('mention-spam notes do not mint stars', () => {
  const clean = buildGalaxy(synth(), { maxNodes: 1e9 })
  const spammy = buildGalaxy(synth({ spamNotes: 100, spamTags: 60 }), { maxNodes: 1e9 })
  // 100 spam notes x 60 tags would have added 6000 stars; none of them may appear
  assert.equal(spammy.nodes.length, clean.nodes.length)
})
t('ghost reaction authors (no profile/note/link) are dropped', () => {
  const g = buildGalaxy(synth({ reactions: 250 }), { maxNodes: 1e9 })
  assert.ok(!g.nodes.some((n) => n.id >= hex(20000) && n.id < hex(20250)))
})
t('maxNodes is enforced and edges never dangle', () => {
  const g = buildGalaxy(synth({ notes: 1500 }), { maxNodes: 300 })
  assert.ok(g.nodes.length <= 300)
  const ids = new Set(g.nodes.map((n) => n.id))
  assert.ok(g.edges.every((e) => ids.has(e.source) && ids.has(e.target)))
})
t('profiles are preferred when trimming to maxNodes', () => {
  const g = buildGalaxy(synth({ profiles: 150, notes: 1500 }), { maxNodes: 150 })
  assert.ok(g.nodes.filter((n) => n.hasProfile).length >= 140)
})
t('constellations still computed on pruned graph', () => {
  const g = buildGalaxy(synth(), { maxNodes: 1200 })
  assert.ok(Array.isArray(detectConstellations(g.nodes, g.edges)))
})
{
  const big = synth({ profiles: 500, notes: 2500, spamNotes: 200, reactions: 1500 })
  const t0 = performance.now()
  const g = buildGalaxy(big, { maxNodes: 1200 })
  console.log(`  info  buildGalaxy on ${big.notes.length} notes -> ${g.nodes.length} stars / ${g.edges.length} links in ${(performance.now() - t0).toFixed(1)}ms`)
}

// ---------- renderer (fake canvas) ----------
console.log('renderer.js')
let rafQueue = []
globalThis.requestAnimationFrame = (cb) => (rafQueue.push(cb), rafQueue.length)
globalThis.cancelAnimationFrame = () => {}
const flush = () => { const q = rafQueue; rafQueue = []; q.forEach((f) => f()) }
let drawCalls = 0
const fakeCtx = new Proxy({}, {
  get: (_, k) => (k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : typeof k === 'string' ? (...a) => { drawCalls++ } : undefined),
  set: () => true
})
class FakeCanvas { constructor(w = 0, h = 0) { this.width = w; this.height = h } getContext() { return fakeCtx } }
globalThis.OffscreenCanvas = FakeCanvas
const images = []
globalThis.Image = class { constructor() { images.push(this) } set src(v) { this._src = v } get src() { return this._src } }
globalThis.document = { createElement: () => new FakeCanvas() }

const { GalaxyRenderer, starRadius } = await import('../src/renderer.js')

function makeGalaxy(n) {
  const nodes = [], edges = []
  for (let i = 0; i < n; i++) {
    nodes.push({ id: hex(i), x: (Math.random() - 0.5) * 6000, y: (Math.random() - 0.5) * 4000, activity: Math.random() * 20,
      color: ['purple', 'green', 'gold', 'blue', 'red'][i % 5], name: 'u' + i, picture: 'https://x/p' + i + '.png', nip05Verified: i % 7 === 0 })
  }
  for (let i = 0; i < n * 2; i++) edges.push({ source: hex(i % n), target: hex((i * 7 + 1) % n), strength: ['weak', 'medium', 'strong'][i % 3] })
  return { nodes, edges }
}
const mk = (n) => {
  const r = new GalaxyRenderer(new FakeCanvas(), { avatarUrlFor: (p) => p + '?thumb' })
  r.resize(1280, 800, 2)
  r.setAvatarsEnabled(true)
  const g = makeGalaxy(n)
  r.setData(g.nodes, g.edges)
  return { r, g }
}

t('hitTest matches brute force across zoom + rotation', () => {
  const { r, g } = mk(1500)
  for (const [scale, rot] of [[0.55, 0], [1.4, 33], [0.2, -120], [3, 200]]) {
    r.placeWorldAt(0, 0, 640, 400, scale, rot)
    for (let k = 0; k < 150; k++) {
      const px = Math.random() * 1280, py = Math.random() * 800
      const w = r.screenToWorld(px, py)
      const min = 20 / scale
      let best = null, bd = Infinity
      for (const n of g.nodes) {
        const d = Math.hypot(n.x - w.x, n.y - w.y)
        if (d <= Math.max(starRadius(n), min) && d < bd) { bd = d; best = n }
      }
      const hit = r.hitTest(px, py)
      // float32 storage can flip a borderline pick; require agreement on null/non-null and nearest unless within 0.5 world px
      if (best && hit) assert.ok(best === hit || Math.abs(Math.hypot(hit.x - w.x, hit.y - w.y) - bd) < 0.5)
      else assert.equal(!!best, !!hit)
    }
  }
})
t('tapping a star at its own screen position selects it', () => {
  const { r, g } = mk(800)
  r.placeWorldAt(0, 0, 640, 400, 0.9, 25)
  const n = g.nodes[123]
  const rad = (25 * Math.PI) / 180
  const sx = r.view.x + (n.x * 0.9 * Math.cos(rad) - n.y * 0.9 * Math.sin(rad))
  const sy = r.view.y + (n.x * 0.9 * Math.sin(rad) + n.y * 0.9 * Math.cos(rad))
  assert.equal(r.hitTest(sx, sy)?.id, n.id)
})
t('placeWorldAt / transformAround keep the anchor fixed', () => {
  const { r } = mk(10)
  r.placeWorldAt(100, -50, 300, 200, 0.7, 10)
  const before = r.screenToWorld(450, 380)
  r.transformAround(450, 380, 1.9, 77)
  const after = r.screenToWorld(450, 380)
  assert.ok(Math.hypot(before.x - after.x, before.y - after.y) < 1e-3)
})
t('centerOn puts the star at the viewport centre', () => {
  const { r, g } = mk(50)
  r.centerOn(g.nodes[7], 1.4)
  const w = r.screenToWorld(640, 400)
  assert.ok(Math.hypot(w.x - g.nodes[7].x, w.y - g.nodes[7].y) < 1e-2)
})
t('scale is clamped', () => {
  const { r } = mk(10)
  r.transformAround(10, 10, 99, 0); assert.equal(r.view.scale, 3)
  r.transformAround(10, 10, 0.0001, 0); assert.equal(r.view.scale, 0.12)
})
t('render() runs at every LOD without throwing; idle = zero work', () => {
  const { r } = mk(1500)
  for (const s of [0.12, 0.3, 0.55, 1.4, 3]) { r.placeWorldAt(0, 0, 640, 400, s, 0); flush() }
  drawCalls = 0; flush()
  assert.equal(drawCalls, 0, 'nothing should be drawn when nothing changed')
})
t('many view changes in one frame coalesce into ONE render', () => {
  const { r } = mk(500); flush()
  let renders = 0; const orig = r.render.bind(r); r.render = () => { renders++; orig() }
  for (let i = 0; i < 200; i++) r.panBy(1, 1)
  flush()
  assert.equal(renders, 1)
})
t('avatars: only on-screen, big-enough stars are requested; concurrency capped', () => {
  images.length = 0
  const { r } = mk(1500)
  r.placeWorldAt(0, 0, 640, 400, 0.12, 0); flush()          // zoomed far out: stars < 9px -> no avatars
  assert.equal(images.length, 0)
  r.placeWorldAt(0, 0, 640, 400, 1.2, 0); flush()           // zoomed in
  assert.ok(images.length > 0 && images.length <= 6, 'inflight=' + images.length)
})
t('avatar load completes -> sprite cached -> repaint requested; failures are not retried', () => {
  images.length = 0
  const { r } = mk(300)
  r.placeWorldAt(0, 0, 640, 400, 1.5, 0); flush()
  const first = images.slice()
  first[0].naturalWidth = first[0].naturalHeight = 64; first[0].onload()
  assert.ok(rafQueue.length > 0, 'a repaint should be queued after an avatar loads')
  first[1].onerror(); flush()
  const urls = images.map((i) => i.src)
  assert.equal(urls.filter((u) => u === first[1].src).length, 1, 'failed avatar must not be re-requested')
})
t('turning avatars off cancels everything and requests nothing new', () => {
  images.length = 0
  const { r } = mk(300)
  r.setAvatarsEnabled(false)
  r.placeWorldAt(0, 0, 640, 400, 1.5, 0); flush()
  assert.equal(images.length, 0)
})
{
  const { r } = mk(1500)
  r.placeWorldAt(0, 0, 640, 400, 0.12, 0)
  const t0 = performance.now(); for (let i = 0; i < 50; i++) r.render(); // direct, fake ctx => measures JS-side cost only
  console.log(`  info  JS-side cost of a frame with 1500 stars / 3000 links: ${((performance.now() - t0) / 50).toFixed(2)}ms (fake ctx; excludes browser raster)`)
}

// ---------- relays ----------
console.log('relays.js')
const R = await import('../src/relays.js')
t('bare host -> wss://, trailing slash stripped, host lower-cased', () => {
  assert.equal(R.parseRelay('Relay.Damus.io/').url, 'wss://relay.damus.io')
  assert.equal(R.parseRelay('  wss://nos.lol  ').url, 'wss://nos.lol')
  assert.equal(R.parseRelay('wss://relay.example.com/nostr/').url, 'wss://relay.example.com/nostr')
})
t('rejects junk, http, creds, insecure ws, bare words', () => {
  for (const bad of ['', '   ', 'http://x.com', 'https://x.com', 'wss://u:p@x.com', 'ws://relay.example.com', 'hello', 'wss://']) {
    assert.ok(R.parseRelay(bad).error, 'should reject: ' + JSON.stringify(bad))
  }
})
t('localhost allows ws://', () => {
  assert.equal(R.parseRelay('ws://localhost:7777').url, 'ws://localhost:7777')
})
t('cleanRelays de-dupes (incl. different spellings) and caps at MAX_RELAYS', () => {
  assert.deepEqual(R.cleanRelays(['nos.lol', 'wss://nos.lol/', 'bad', 'relay.damus.io']), ['wss://nos.lol', 'wss://relay.damus.io'])
  const many = Array.from({ length: 20 }, (_, i) => `r${i}.example.com`)
  assert.equal(R.cleanRelays(many).length, R.MAX_RELAYS)
})
t('URL round-trip is short, readable, and keeps other params', () => {
  const list = ['wss://relay.damus.io', 'wss://relay.bchnostr.com', 'ws://localhost:7777', 'wss://r.example.com/nostr']
  const qs = R.relaysToSearch(list, '?foo=1&relay=old.example.com')
  assert.equal(qs, '?foo=1&relay=relay.damus.io&relay=relay.bchnostr.com&relay=ws://localhost:7777&relay=r.example.com/nostr')
  assert.deepEqual(R.relaysFromSearch(qs), list)
})
t('?relays=a,b comma form and empty search work', () => {
  assert.deepEqual(R.relaysFromSearch('?relays=nos.lol,relay.damus.io'), ['wss://nos.lol', 'wss://relay.damus.io'])
  assert.deepEqual(R.relaysFromSearch(''), [])
  assert.equal(R.relaysToSearch([], '?foo=1'), '?foo=1')
  assert.equal(R.relaysToSearch([], ''), '')
})
t('storage save/load/clear; broken storage never throws', () => {
  const mem = new Map(); const st = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) }
  R.saveStoredRelays(st, ['wss://nos.lol']); assert.deepEqual(R.loadStoredRelays(st), ['wss://nos.lol'])
  R.saveStoredRelays(st, null); assert.deepEqual(R.loadStoredRelays(st), [])
  mem.set('galaxstr.relays', '{not json'); assert.deepEqual(R.loadStoredRelays(st), [])
  const boom = { getItem() { throw new Error('x') }, setItem() { throw new Error('x') }, removeItem() { throw new Error('x') } }
  R.saveStoredRelays(boom, ['wss://nos.lol']); assert.deepEqual(R.loadStoredRelays(boom), [])
})

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
