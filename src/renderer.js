// renderer.js — draws the galaxy on a single <canvas> instead of one DOM
// subtree per star.
//
// Why: each DOM star was ~6 elements (button, glow, body, img, badge, label)
// with a blur() filter + box-shadow, all inside a scaled layer, and every
// pan/zoom frame re-ran culling and re-rendered them through Vue. Canvas
// turns that into a few hundred cheap draw calls per frame, only when
// something actually changed (render-on-demand: zero idle CPU).
//
// No Vue in here on purpose: the component owns input + props, this owns
// camera math, drawing, hit-testing and the avatar cache.

const COLORS = {
  purple: '#9b8cff',
  green: '#4fd48a',
  gold: '#f2c14e',
  blue: '#6ea8fe',
  red: '#e0637a'
}
const PANEL = '#0b0e18'
const LINK_RGB = '243,241,234'
const DIM = '#8a90a8'
const WHITE = '#f3f1ea'

export const MIN_SCALE = 0.12
export const MAX_SCALE = 3

export function starRadius(node) {
  return 13 + Math.sqrt(1 + (node.activity || 0)) * 3.8
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

// One radial-gradient glow sprite per colour, drawn scaled — a blurred DOM
// element per star is what made the old version so heavy to paint.
function makeGlowSprite(color) {
  const size = 64
  const c = makeCanvas(size, size)
  const g = c.getContext('2d')
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  grad.addColorStop(0, color)
  grad.addColorStop(0.35, color + '99')
  grad.addColorStop(1, color + '00')
  g.fillStyle = grad
  g.fillRect(0, 0, size, size)
  return c
}

/**
 * Loads avatars lazily, a few at a time, and keeps them as small
 * pre-clipped circular sprites in an LRU. Only stars that are on screen
 * *and* big enough to show a face ever ask for one, and requests that
 * scroll out of view before a slot frees up are simply dropped.
 */
export class AvatarCache {
  constructor({ urlFor, onChange, maxSprites = 400, maxInflight = 6, spriteSize = 64, timeoutMs = 12000 }) {
    this.urlFor = urlFor // picture -> url | null
    this.onChange = onChange
    this.maxSprites = maxSprites
    this.maxInflight = maxInflight
    this.spriteSize = spriteSize
    this.timeoutMs = timeoutMs
    this.sprites = new Map() // picture -> sprite canvas | null (failed)
    this.inflight = new Set()
    this.pending = new Set() // wanted this frame, not started yet
    this.generation = 0
  }

  reset() {
    this.generation++
    this.sprites.clear()
    this.inflight.clear()
    this.pending.clear()
  }

  beginFrame() {
    this.pending.clear()
  }

  get(picture) {
    const hit = this.sprites.get(picture)
    if (hit) {
      // refresh LRU position
      this.sprites.delete(picture)
      this.sprites.set(picture, hit)
      return hit
    }
    if (hit === null) return null // known-bad, don't retry
    if (!this.inflight.has(picture)) this.pending.add(picture)
    return null
  }

  endFrame() {
    for (const picture of this.pending) {
      if (this.inflight.size >= this.maxInflight) break
      this._load(picture)
    }
    this.pending.clear()
  }

  _load(picture) {
    const url = this.urlFor(picture)
    if (!url) return
    const gen = this.generation
    this.inflight.add(picture)
    const img = new Image()
    img.decoding = 'async'
    let done = false
    const finish = (sprite) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (gen !== this.generation) return
      this.inflight.delete(picture)
      this.sprites.set(picture, sprite)
      while (this.sprites.size > this.maxSprites) {
        this.sprites.delete(this.sprites.keys().next().value)
      }
      this.onChange?.()
    }
    const timer = setTimeout(() => {
      img.src = ''
      finish(null)
    }, this.timeoutMs)
    img.onload = () => finish(this._toSprite(img))
    img.onerror = () => finish(null)
    img.src = url
  }

  _toSprite(img) {
    try {
      const n = this.spriteSize
      const c = makeCanvas(n, n)
      const g = c.getContext('2d')
      g.beginPath()
      g.arc(n / 2, n / 2, n / 2, 0, Math.PI * 2)
      g.clip()
      const side = Math.min(img.naturalWidth || n, img.naturalHeight || n)
      const sx = ((img.naturalWidth || n) - side) / 2
      const sy = ((img.naturalHeight || n) - side) / 2
      g.drawImage(img, sx, sy, side, side, 0, 0, n, n)
      return c
    } catch {
      return null
    }
  }
}

export class GalaxyRenderer {
  constructor(canvas, { coarse = false, avatarUrlFor = () => null, onRotationChange = null } = {}) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.coarse = coarse
    this.onRotationChange = onRotationChange
    this.view = { x: 0, y: 0, scale: 0.55, rotation: 0 }
    this.w = 1
    this.h = 1
    this.dpr = 1
    this.selectedId = null
    this.avatarsOn = false
    this.rafId = null
    this.destroyed = false
    this._lastReportedRotation = 0

    this.nodes = []
    this.n = 0
    this.wx = new Float32Array(0)
    this.wy = new Float32Array(0)
    this.rad = new Float32Array(0)
    this.sx = new Float32Array(0)
    this.sy = new Float32Array(0)
    this.indexById = new Map()
    this.edgeBuckets = { weak: new Int32Array(0), medium: new Int32Array(0), strong: new Int32Array(0) }
    this.grid = new Map()
    this.cell = 160
    this.maxRad = 20

    this.glow = {}
    for (const [name, hex] of Object.entries(COLORS)) this.glow[name] = makeGlowSprite(hex)

    this.avatars = new AvatarCache({
      urlFor: avatarUrlFor,
      onChange: () => this.requestRender(),
      spriteSize: coarse ? 48 : 64,
      maxSprites: coarse ? 250 : 500
    })
  }

  // ---------- sizing ----------
  resize(width, height, devicePixelRatio = 1) {
    // Cap DPR: 3x phones would otherwise paint 9 device px per CSS px.
    this.dpr = Math.min(devicePixelRatio || 1, 2)
    this.w = Math.max(1, width)
    this.h = Math.max(1, height)
    this.canvas.width = Math.round(this.w * this.dpr)
    this.canvas.height = Math.round(this.h * this.dpr)
    this.requestRender()
  }

  // ---------- data ----------
  setData(nodes, edges) {
    this.nodes = nodes
    const n = (this.n = nodes.length)
    this.wx = new Float32Array(n)
    this.wy = new Float32Array(n)
    this.rad = new Float32Array(n)
    this.sx = new Float32Array(n)
    this.sy = new Float32Array(n)
    this.indexById = new Map()
    let maxRad = 20
    for (let i = 0; i < n; i++) {
      const node = nodes[i]
      this.wx[i] = node.x
      this.wy[i] = node.y
      const r = starRadius(node)
      this.rad[i] = r
      if (r > maxRad) maxRad = r
      this.indexById.set(node.id, i)
    }
    this.maxRad = maxRad

    const buckets = { weak: [], medium: [], strong: [] }
    for (const e of edges) {
      const a = this.indexById.get(e.source?.id ?? e.source)
      const b = this.indexById.get(e.target?.id ?? e.target)
      if (a === undefined || b === undefined) continue
      buckets[e.strength === 'strong' ? 'strong' : e.strength === 'medium' ? 'medium' : 'weak'].push(a, b)
    }
    this.edgeBuckets = {
      weak: Int32Array.from(buckets.weak),
      medium: Int32Array.from(buckets.medium),
      strong: Int32Array.from(buckets.strong)
    }

    // Uniform grid in world space for tap hit-testing.
    this.grid = new Map()
    for (let i = 0; i < n; i++) {
      const key = this._cellKey(Math.floor(this.wx[i] / this.cell), Math.floor(this.wy[i] / this.cell))
      let bucket = this.grid.get(key)
      if (!bucket) this.grid.set(key, (bucket = []))
      bucket.push(i)
    }
    this.requestRender()
  }

  setSelected(id) {
    this.selectedId = id
    this.requestRender()
  }

  _cellKey(cx, cy) {
    return (cx + 8192) * 16384 + (cy + 8192)
  }

  // ---------- camera ----------
  screenToWorld(px, py) {
    const { x, y, scale, rotation } = this.view
    const rad = (rotation * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    const dx = px - x
    const dy = py - y
    return { x: (dx * cos + dy * sin) / scale, y: (-dx * sin + dy * cos) / scale }
  }

  /** Puts world point (wx,wy) at screen point (px,py) with the given scale/rotation. */
  placeWorldAt(wx, wy, px, py, scale, rotation) {
    const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
    const rad = (rotation * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    this.view.scale = s
    this.view.rotation = rotation
    this.view.x = px - (wx * s * cos - wy * s * sin)
    this.view.y = py - (wx * s * sin + wy * s * cos)
    this.requestRender()
  }

  /** Changes scale/rotation while keeping whatever is under (px,py) fixed. */
  transformAround(px, py, scale, rotation) {
    const w = this.screenToWorld(px, py)
    this.placeWorldAt(w.x, w.y, px, py, scale, rotation)
  }

  panBy(dx, dy) {
    this.view.x += dx
    this.view.y += dy
    this.requestRender()
  }

  centerOn(node, scale = 1.4) {
    if (!node) return
    this.placeWorldAt(node.x, node.y, this.w / 2, this.h / 2, scale, this.view.rotation)
  }

  // ---------- hit testing ----------
  /** px,py in canvas CSS pixels. Returns the tapped node or null. */
  hitTest(px, py) {
    if (!this.n) return null
    const world = this.screenToWorld(px, py)
    const s = this.view.scale
    // Tap target: never smaller than ~20px on screen (finger-sized).
    const minWorld = 20 / s
    const reach = Math.max(this.maxRad, minWorld)
    const c0x = Math.floor((world.x - reach) / this.cell)
    const c1x = Math.floor((world.x + reach) / this.cell)
    const c0y = Math.floor((world.y - reach) / this.cell)
    const c1y = Math.floor((world.y + reach) / this.cell)
    let best = -1
    let bestD = Infinity
    for (let cx = c0x; cx <= c1x; cx++) {
      for (let cy = c0y; cy <= c1y; cy++) {
        const bucket = this.grid.get(this._cellKey(cx, cy))
        if (!bucket) continue
        for (const i of bucket) {
          const d = Math.hypot(this.wx[i] - world.x, this.wy[i] - world.y)
          const limit = Math.max(this.rad[i], minWorld)
          if (d <= limit && d < bestD) {
            bestD = d
            best = i
          }
        }
      }
    }
    return best >= 0 ? this.nodes[best] : null
  }

  // ---------- drawing ----------
  requestRender() {
    if (this.destroyed || this.rafId !== null) return
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null
      this.render()
    })
  }

  render() {
    if (this.destroyed) return
    const { ctx, view, w, h, n } = this
    const dpr = this.dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const s = view.scale
    const rot = (view.rotation * Math.PI) / 180
    const cos = Math.cos(rot)
    const sin = Math.sin(rot)
    const { wx, wy, sx, sy, rad } = this

    // 1) project every star once (typed arrays, no allocation)
    for (let i = 0; i < n; i++) {
      const lx = wx[i] * s
      const ly = wy[i] * s
      sx[i] = view.x + (lx * cos - ly * sin)
      sy[i] = view.y + (lx * sin + ly * cos)
    }

    // 2) links: one path + one stroke per strength class
    const M = 60
    const styles = [
      ['weak', 0.6, 0.16],
      ['medium', 1.2, 0.32],
      ['strong', 2, 0.55]
    ]
    ctx.lineCap = 'round'
    for (const [name, width, alpha] of styles) {
      const pairs = this.edgeBuckets[name]
      if (!pairs.length) continue
      ctx.beginPath()
      for (let k = 0; k < pairs.length; k += 2) {
        const a = pairs[k]
        const b = pairs[k + 1]
        const ax = sx[a]
        const ay = sy[a]
        const bx = sx[b]
        const by = sy[b]
        if ((ax < -M && bx < -M) || (ax > w + M && bx > w + M) || (ay < -M && by < -M) || (ay > h + M && by > h + M)) continue
        ctx.moveTo(ax, ay)
        ctx.lineTo(bx, by)
      }
      ctx.strokeStyle = `rgba(${LINK_RGB},${alpha})`
      ctx.lineWidth = Math.max(0.5, width * s)
      ctx.stroke()
    }

    // 3) stars, level-of-detail by on-screen size
    this.avatars.beginFrame()
    const mode = this._avatarsEnabled()
    const labelCandidates = []
    const showLabels = s >= 0.4
    const margin = 80
    let selectedIdx = -1

    for (let i = 0; i < n; i++) {
      const x = sx[i]
      const y = sy[i]
      const rs = Math.max(rad[i] * s, 1.5)
      if (x < -margin - rs || x > w + margin + rs || y < -margin - rs || y > h + margin + rs) continue
      const node = this.nodes[i]
      const color = COLORS[node.color] || COLORS.purple

      if (node.id === this.selectedId) selectedIdx = i

      if (rs < 4) {
        // distant: a plain dot
        ctx.globalAlpha = 0.9
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(x, y, rs, 0, 6.2832)
        ctx.fill()
        ctx.globalAlpha = 1
        continue
      }

      // glow sprite (skipped for tiny stars in dense views)
      const gsz = rs * 1.9
      ctx.globalAlpha = 0.55
      ctx.drawImage(this.glow[node.color] || this.glow.purple, x - gsz, y - gsz, gsz * 2, gsz * 2)
      ctx.globalAlpha = 1

      // body
      ctx.beginPath()
      ctx.arc(x, y, rs, 0, 6.2832)
      ctx.fillStyle = PANEL
      ctx.fill()

      let drewAvatar = false
      if (rs >= 9 && node.picture && mode) {
        const sprite = this.avatars.get(node.picture)
        if (sprite) {
          ctx.drawImage(sprite, x - rs, y - rs, rs * 2, rs * 2)
          drewAvatar = true
        }
      }
      if (!drewAvatar && rs >= 9) {
        ctx.fillStyle = color
        ctx.font = `${Math.round(rs * 0.9)}px sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText('✦', x, y + 1)
      }

      ctx.beginPath()
      ctx.arc(x, y, rs, 0, 6.2832)
      ctx.lineWidth = 1.5
      ctx.strokeStyle = color
      ctx.stroke()

      if (node.nip05Verified && rs >= 10) {
        const br = Math.max(3.5, rs * 0.22)
        ctx.beginPath()
        ctx.arc(x + rs * 0.72, y - rs * 0.72, br, 0, 6.2832)
        ctx.fillStyle = COLORS.gold
        ctx.fill()
      }

      if (showLabels && rs >= 9) labelCandidates.push(i)
    }

    this.avatars.endFrame()

    // 4) labels — biggest stars first, hard-capped
    if (labelCandidates.length) {
      const LABEL_MAX = this.coarse ? 40 : 90
      if (labelCandidates.length > LABEL_MAX) {
        labelCandidates.sort((a, b) => rad[b] - rad[a])
        labelCandidates.length = LABEL_MAX
      }
      ctx.font = '11px "Space Grotesk", -apple-system, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      ctx.fillStyle = DIM
      for (const i of labelCandidates) {
        const node = this.nodes[i]
        const name = node.name || node.id.slice(0, 8)
        ctx.fillText(name.length > 18 ? name.slice(0, 17) + '…' : name, sx[i], sy[i] + Math.max(rad[i] * s, 1.5) + 4)
      }
    }

    // 5) selection ring on top
    if (selectedIdx >= 0) {
      const rs = Math.max(rad[selectedIdx] * s, 4)
      ctx.beginPath()
      ctx.arc(sx[selectedIdx], sy[selectedIdx], rs + 3, 0, 6.2832)
      ctx.lineWidth = 2
      ctx.strokeStyle = WHITE
      ctx.stroke()
    }

    if (this.onRotationChange && Math.abs(view.rotation - this._lastReportedRotation) > 0.05) {
      this._lastReportedRotation = view.rotation
      this.onRotationChange(view.rotation)
    }
  }

  _avatarsEnabled() {
    return !!this.avatarsOn
  }

  setAvatarsEnabled(on) {
    this.avatarsOn = !!on
    this.avatars.reset()
    this.requestRender()
  }

  destroy() {
    this.destroyed = true
    if (this.rafId !== null) cancelAnimationFrame(this.rafId)
    this.rafId = null
    this.avatars.reset()
  }
}
