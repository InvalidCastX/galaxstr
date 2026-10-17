// layout.js — force-directed star placement.
//
// Pure computation (no DOM, no Vue) so it can run either inside a Web Worker
// (layout.worker.js — the normal path) or on the main thread as a fallback.
//
// Input/output are deliberately minimal (ids + activity + slim edges in,
// a flat Float32Array of x,y pairs out) so very little has to be cloned
// across the worker boundary.

import { forceSimulation, forceManyBody, forceLink, forceCenter, forceCollide } from 'd3-force'

/**
 * nodes:    [{ id, activity }]
 * edges:    [{ source, target, weight }]   (source/target are node ids)
 * previous: Map<id,{x,y}> | Array<[id,x,y]> — already-settled positions.
 *           Those stars are pinned (fx/fy); only new stars move.
 * Returns Float32Array [x0,y0,x1,y1,...] in the same order as `nodes`.
 */
export function computeLayout({ nodes, edges, previous = null, ticks = 300 }) {
  const prev =
    previous instanceof Map
      ? previous
      : new Map((previous || []).map(([id, x, y]) => [id, { x, y }]))
  const isWarmStart = prev.size > 0
  let newCount = 0

  const simNodes = nodes.map((n) => {
    const p = prev.get(n.id)
    if (p) return { id: n.id, activity: n.activity, x: p.x, y: p.y, vx: 0, vy: 0, fx: p.x, fy: p.y }
    newCount++
    return { id: n.id, activity: n.activity }
  })

  const out = new Float32Array(simNodes.length * 2)
  const writeOut = () => {
    for (let i = 0; i < simNodes.length; i++) {
      out[i * 2] = simNodes[i].x || 0
      out[i * 2 + 1] = simNodes[i].y || 0
    }
    return out
  }

  // Nothing new arrived — every star is pinned, nothing to simulate.
  if (isWarmStart && newCount === 0) return writeOut()

  const idIndex = new Map(simNodes.map((n) => [n.id, n]))
  const simLinks = []
  for (const e of edges) {
    if (idIndex.has(e.source) && idIndex.has(e.target)) {
      simLinks.push({ source: e.source, target: e.target, weight: e.weight })
    }
  }

  if (isWarmStart) {
    // Seed brand-new stars near an already-placed neighbour so they drift
    // into place from nearby instead of from the origin.
    for (const link of simLinks) {
      const a = idIndex.get(link.source)
      const b = idIndex.get(link.target)
      if (a.x === undefined && b.x !== undefined) {
        a.x = b.x + (Math.random() - 0.5) * 40
        a.y = b.y + (Math.random() - 0.5) * 40
      } else if (b.x === undefined && a.x !== undefined) {
        b.x = a.x + (Math.random() - 0.5) * 40
        b.y = a.y + (Math.random() - 0.5) * 40
      }
    }
  }

  const effectiveTicks = isWarmStart ? Math.min(160, Math.max(40, newCount * 5)) : ticks

  const sim = forceSimulation(simNodes)
    // Make alpha finish decaying exactly when our tick budget ends, instead
    // of d3's fixed ~300-tick schedule — fewer ticks no longer means a
    // half-cooled (jittery) layout.
    .alphaDecay(1 - Math.pow(0.001, 1 / effectiveTicks))
    .force(
      'link',
      forceLink(simLinks)
        .id((d) => d.id)
        .distance((l) => 260 - Math.min(l.weight, 10) * 18)
        .strength((l) => Math.min(0.05 + l.weight * 0.02, 0.4))
    )
    // distanceMax bounds the repulsion range: far-apart stars stop paying
    // for each other, which is the big saving once there are hundreds.
    .force('charge', forceManyBody().strength(-140).theta(1.0).distanceMax(700))
    .force('center', isWarmStart ? null : forceCenter(0, 0))
    .force(
      'collide',
      forceCollide((d) => 26 + Math.sqrt(1 + (d.activity || 0)) * 4.5).iterations(2)
    )
    .stop()

  for (let i = 0; i < effectiveTicks; i++) sim.tick()

  return writeOut()
}
