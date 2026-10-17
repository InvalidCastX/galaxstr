// Runs computeLayout off the main thread so a layout pass never freezes
// panning / tapping.
import { computeLayout } from './layout.js'

self.onmessage = (e) => {
  const { seq, nodes, edges, previous, ticks } = e.data
  try {
    const xy = computeLayout({ nodes, edges, previous, ticks })
    self.postMessage({ seq, xy }, [xy.buffer])
  } catch (err) {
    self.postMessage({ seq, error: String((err && err.message) || err) })
  }
}
