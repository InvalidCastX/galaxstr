// layoutClient.js — promise wrapper around the layout worker, with a
// main-thread fallback if Workers are unavailable or the worker fails.

import { computeLayout } from './layout.js'

export class LayoutClient {
  constructor() {
    this.seq = 0
    this.pending = new Map() // seq -> { resolve, job }
    this.worker = null
    try {
      this.worker = new Worker(new URL('./layout.worker.js', import.meta.url), { type: 'module' })
      this.worker.onmessage = (e) => {
        const { seq, xy, error } = e.data
        const entry = this.pending.get(seq)
        if (!entry) return
        this.pending.delete(seq)
        if (error) entry.resolve(this._runSync(entry.job))
        else entry.resolve(xy)
      }
      this.worker.onerror = () => this._fallBack()
    } catch {
      this.worker = null
    }
  }

  _runSync(job) {
    return computeLayout(job)
  }

  _fallBack() {
    // Worker died (CSP, old browser, bundler quirk…): finish everything
    // queued on the main thread and stay there from now on.
    try {
      this.worker?.terminate()
    } catch {
      /* noop */
    }
    this.worker = null
    for (const [seq, entry] of this.pending) {
      this.pending.delete(seq)
      entry.resolve(this._runSync(entry.job))
    }
  }

  /** nodes: [{id,activity}], edges: [{source,target,weight}], previous: Map<id,{x,y}> */
  run(nodes, edges, previous, ticks = 300) {
    const prevArr = []
    for (const [id, p] of previous) prevArr.push([id, p.x, p.y])
    const job = { nodes, edges, previous: prevArr, ticks }
    if (!this.worker) {
      // yield once so the caller's UI work isn't blocked behind this call
      return new Promise((resolve) => setTimeout(() => resolve(this._runSync(job)), 0))
    }
    const seq = ++this.seq
    return new Promise((resolve) => {
      this.pending.set(seq, { resolve, job })
      this.worker.postMessage({ seq, ...job })
    })
  }

  destroy() {
    try {
      this.worker?.terminate()
    } catch {
      /* noop */
    }
    this.worker = null
    this.pending.clear()
  }
}
