<script setup>
import { ref, computed, inject, watch, onMounted, onBeforeUnmount } from 'vue'
import { GalaxyRenderer } from '../renderer.js'
import { avatarThumb } from '../image.js'

const props = defineProps({
  nodes: { type: Array, default: () => [] },
  edges: { type: Array, default: () => [] },
  selectedId: { type: String, default: null },
  focusToken: { type: Object, default: () => ({ id: null, nonce: 0 }) } // { id, nonce } — camera pans/zooms to id whenever nonce changes
})
const emit = defineEmits(['select-star', 'background-click'])

const viewportEl = ref(null)
const canvasEl = ref(null)
const rotationDeg = ref(0) // only used to turn the compass needle

// 'off' skips avatars entirely, 'saver' fetches a small resized version,
// 'full' loads the original. Provided from App.vue.
const dataMode = inject('dataMode', computed(() => 'saver'))

const isCoarsePointer = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches

// The whole galaxy is drawn on one <canvas> by GalaxyRenderer (see
// renderer.js). The camera lives in plain (non-reactive) state there, so
// panning/zooming never goes through Vue's reactivity or a vdom diff — it
// just schedules one canvas repaint per animation frame.
let renderer = null
let resizeObserver = null

function avatarUrlFor(picture) {
  if (!picture || dataMode.value === 'off') return null
  return dataMode.value === 'full' ? picture : avatarThumb(picture, 64)
}

// --- pointer gestures (mouse + touch + pen through one code path) ---
const pointers = new Map() // pointerId -> { x, y } in canvas CSS px
let gesture = null // { type: 'pan' | 'pinch', ... }
const TAP_SLOP = 6

function localPoint(e) {
  const rect = canvasEl.value.getBoundingClientRect()
  return { x: e.clientX - rect.left, y: e.clientY - rect.top }
}

function beginPinch() {
  const [a, b] = [...pointers.values()]
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  gesture = {
    type: 'pinch',
    d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
    angle0: Math.atan2(b.y - a.y, b.x - a.x),
    scale0: renderer.view.scale,
    rotation0: renderer.view.rotation,
    anchor: renderer.screenToWorld(mid.x, mid.y) // world point that stays under the fingers
  }
}

function onPointerDown(e) {
  if (!renderer || (e.pointerType === 'mouse' && e.button !== 0)) return
  canvasEl.value.setPointerCapture?.(e.pointerId)
  pointers.set(e.pointerId, localPoint(e))
  if (pointers.size === 1) {
    const p = pointers.get(e.pointerId)
    gesture = { type: 'pan', startX: p.x, startY: p.y, lastX: p.x, lastY: p.y, moved: false }
  } else if (pointers.size === 2) {
    beginPinch()
  }
}

function onPointerMove(e) {
  if (!renderer || !pointers.has(e.pointerId) || !gesture) return
  const p = localPoint(e)
  pointers.set(e.pointerId, p)
  if (gesture.type === 'pan' && pointers.size === 1) {
    if (!gesture.moved && Math.hypot(p.x - gesture.startX, p.y - gesture.startY) > TAP_SLOP) gesture.moved = true
    if (gesture.moved) {
      renderer.panBy(p.x - gesture.lastX, p.y - gesture.lastY)
      gesture.lastX = p.x
      gesture.lastY = p.y
    }
  } else if (gesture.type === 'pinch' && pointers.size >= 2) {
    const [a, b] = [...pointers.values()]
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    const d = Math.hypot(a.x - b.x, a.y - b.y)
    const angle = Math.atan2(b.y - a.y, b.x - a.x)
    const deltaDeg = ((angle - gesture.angle0) * 180) / Math.PI
    // Keep the world point that started under the fingers under their
    // midpoint: pinch-zoom, twist-rotate and two-finger pan in one move.
    renderer.placeWorldAt(
      gesture.anchor.x,
      gesture.anchor.y,
      mid.x,
      mid.y,
      gesture.scale0 * (d / gesture.d0),
      gesture.rotation0 + deltaDeg
    )
  }
}

function endPointer(e, cancelled) {
  if (!pointers.has(e.pointerId)) return
  const p = pointers.get(e.pointerId)
  pointers.delete(e.pointerId)
  canvasEl.value?.releasePointerCapture?.(e.pointerId)

  if (gesture?.type === 'pan' && !gesture.moved && !cancelled && pointers.size === 0 && renderer) {
    // A tap, not a drag: select the star under the finger, or dismiss.
    const hit = renderer.hitTest(p.x, p.y)
    if (hit) emit('select-star', hit)
    else emit('background-click')
  }

  if (pointers.size === 0) {
    gesture = null
  } else if (pointers.size === 1) {
    // Went from two fingers to one: continue as a pan from where it is now.
    const rest = [...pointers.values()][0]
    gesture = { type: 'pan', startX: rest.x, startY: rest.y, lastX: rest.x, lastY: rest.y, moved: true }
  } else {
    beginPinch()
  }
}

function onWheel(e) {
  if (!renderer) return
  e.preventDefault()
  const p = localPoint(e)
  if (e.shiftKey) {
    // Desktop rotate: shift+scroll turns the map around the cursor.
    renderer.transformAround(p.x, p.y, renderer.view.scale, renderer.view.rotation + e.deltaY * 0.15)
    return
  }
  const delta = -e.deltaY * 0.0012
  renderer.transformAround(p.x, p.y, renderer.view.scale * (1 + delta), renderer.view.rotation)
}

function resetRotation() {
  if (!renderer) return
  renderer.transformAround(renderer.w / 2, renderer.h / 2, renderer.view.scale, 0)
}

function syncSize() {
  if (!renderer || !viewportEl.value) return
  const rect = viewportEl.value.getBoundingClientRect()
  renderer.resize(rect.width, rect.height, window.devicePixelRatio || 1)
}

onMounted(() => {
  renderer = new GalaxyRenderer(canvasEl.value, {
    coarse: isCoarsePointer,
    avatarUrlFor,
    onRotationChange: (deg) => (rotationDeg.value = deg)
  })
  syncSize()
  // start with the world origin in the middle of the screen
  renderer.placeWorldAt(0, 0, renderer.w / 2, renderer.h / 2, renderer.view.scale, 0)
  renderer.setAvatarsEnabled(dataMode.value !== 'off')
  renderer.setData(props.nodes, props.edges)
  renderer.setSelected(props.selectedId)

  // wheel must be non-passive so preventDefault() can stop page scroll/zoom
  canvasEl.value.addEventListener('wheel', onWheel, { passive: false })
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(syncSize)
    resizeObserver.observe(viewportEl.value)
  } else {
    window.addEventListener('resize', syncSize)
  }
})

onBeforeUnmount(() => {
  canvasEl.value?.removeEventListener('wheel', onWheel)
  resizeObserver?.disconnect()
  window.removeEventListener('resize', syncSize)
  renderer?.destroy()
  renderer = null
})

// Data changes arrive in whole-array swaps (App.vue uses shallowRef), so a
// plain reference watch is enough — no deep traversal of thousands of items.
watch(
  () => [props.nodes, props.edges],
  () => renderer?.setData(props.nodes, props.edges)
)
watch(
  () => props.selectedId,
  (id) => renderer?.setSelected(id)
)
watch(dataMode, (mode) => renderer?.setAvatarsEnabled(mode !== 'off'))
watch(
  () => props.focusToken?.nonce,
  () => {
    const id = props.focusToken?.id
    const node = id && props.nodes.find((n) => n.id === id)
    if (node && renderer) renderer.centerOn(node)
  }
)
</script>

<template>
  <div ref="viewportEl" class="galaxy-viewport">
    <canvas
      ref="canvasEl"
      class="galaxy-canvas"
      role="img"
      aria-label="Interactive map of Nostr accounts. Use the search box to find a specific account."
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="(e) => endPointer(e, false)"
      @pointercancel="(e) => endPointer(e, true)"
    ></canvas>

    <button
      class="compass"
      :class="{ 'compass--active': Math.abs(rotationDeg % 360) > 1 }"
      @click.stop="resetRotation"
      aria-label="Reset rotation to north"
      title="Reset rotation"
    >
      <span class="compass__needle" :style="{ transform: `rotate(${-rotationDeg}deg)` }">▲</span>
    </button>
  </div>
</template>

<style scoped>
.galaxy-viewport {
  position: absolute;
  inset: 0;
  overflow: hidden;
  touch-action: none;
  cursor: grab;
  background: radial-gradient(ellipse at 50% 40%, rgba(80, 70, 140, 0.12), transparent 60%), var(--bg-void);
}
.galaxy-viewport:active {
  cursor: grabbing;
}

.galaxy-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  touch-action: none;
}

.compass {
  position: absolute;
  right: calc(14px + env(safe-area-inset-right));
  top: 50%;
  transform: translateY(-50%);
  z-index: 4;
  width: 42px;
  height: 42px;
  border-radius: 50%;
  background: var(--bg-panel);
  backdrop-filter: blur(10px);
  border: 1px solid var(--hairline);
  color: var(--dim);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
}
.compass--active {
  color: var(--c-purple);
  border-color: var(--c-purple);
}
.compass__needle {
  display: inline-block;
  line-height: 1;
}
</style>
