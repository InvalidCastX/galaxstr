// nostr.js — a minimal, dependency-free NIP-01 relay client.
//
// This talks raw WebSocket JSON to public relays. It never asks for,
// stores, or transmits a private key (nsec) — it only ever sends
// REQ / CLOSE messages and reads EVENT / EOSE / NOTICE frames back.
// Read-only, public-data-only, by construction.

// 'wss://relay.nos.lol' and 'wss://nos.lol' resolve to the same relay, so
// only one is kept — connecting to both just doubles traffic for zero
// extra coverage, since the pool already de-dupes by relay, not by event.
const DEFAULT_RELAYS = [
  'wss://relay.bchnostr.com',
  'wss://relay.nos.lol',
  'wss://relay.damus.io'
]

function randId() {
  return Math.random().toString(36).slice(2, 12)
}

/**
 * Connects to a set of relays and lets you run one or more subscriptions
 * across all of them at once, merging + de-duplicating events by id.
 */
export class RelayPool {
  constructor(relayUrls = DEFAULT_RELAYS) {
    this.relayUrls = relayUrls
    this.sockets = new Map() // url -> WebSocket
    this.status = new Map() // url -> 'connecting' | 'open' | 'closed' | 'error'
    this.subs = new Map() // subId -> { filters, onEvent, onEose, seen: Set, closed }
    this.onStatusChange = null
  }

  get connectedCount() {
    return [...this.status.values()].filter((s) => s === 'open').length
  }

  connect() {
    this.relayUrls.forEach((url) => this._connectOne(url))
  }

  _connectOne(url) {
    this.status.set(url, 'connecting')
    let ws
    try {
      ws = new WebSocket(url)
    } catch (err) {
      this.status.set(url, 'error')
      this._emitStatus()
      return
    }
    this.sockets.set(url, ws)

    ws.addEventListener('open', () => {
      this.status.set(url, 'open')
      this._emitStatus()
      // Replay any active subscriptions onto this newly-open relay.
      for (const [subId, sub] of this.subs) {
        if (!sub.closed) this._send(ws, ['REQ', subId, ...sub.filters])
      }
    })

    ws.addEventListener('message', (msg) => {
      let data
      try {
        data = JSON.parse(msg.data)
      } catch {
        return
      }
      const [type, ...rest] = data
      if (type === 'EVENT') {
        const [subId, event] = rest
        this._handleEvent(subId, event)
      } else if (type === 'EOSE') {
        const [subId] = rest
        const sub = this.subs.get(subId)
        if (sub && sub.onEose) sub.onEose(url)
      }
      // NOTICE / OK / CLOSED frames are ignored — this client never
      // publishes events, so it doesn't need to act on them.
    })

    const onDown = () => {
      this.status.set(url, 'closed')
      this._emitStatus()
    }
    ws.addEventListener('close', onDown)
    ws.addEventListener('error', onDown)
  }

  _handleEvent(subId, event) {
    if (!event || !event.id) return
    const sub = this.subs.get(subId)
    if (!sub) return
    // De-dup per subscription: the same event often arrives from several
    // relays. The set lives on the sub, so it is freed when the sub closes
    // (a single global set would grow for as long as the tab is open).
    if (sub.seen.has(event.id)) return
    sub.seen.add(event.id)
    sub.onEvent(event)
  }

  _send(ws, msg) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  _emitStatus() {
    if (this.onStatusChange) this.onStatusChange(this.statusSummary())
  }

  statusSummary() {
    const summary = {}
    for (const url of this.relayUrls) summary[url] = this.status.get(url) || 'connecting'
    return summary
  }

  /**
   * Opens a subscription across every relay in the pool.
   * filters: array of NIP-01 filter objects, e.g. [{ kinds: [0], limit: 500 }]
   * Returns a subscription id you can pass to close().
   */
  subscribe(filters, { onEvent, onEose } = {}) {
    const subId = randId()
    this.subs.set(subId, { filters, onEvent: onEvent || (() => {}), onEose, seen: new Set(), closed: false })
    for (const [url, ws] of this.sockets) {
      if (this.status.get(url) === 'open') this._send(ws, ['REQ', subId, ...filters])
    }
    return subId
  }

  close(subId) {
    const sub = this.subs.get(subId)
    if (!sub) return
    sub.closed = true
    for (const [, ws] of this.sockets) this._send(ws, ['CLOSE', subId])
    this.subs.delete(subId)
  }

  /** Stops every subscription but keeps the sockets open (for later REQs). */
  closeSubs() {
    for (const subId of [...this.subs.keys()]) this.close(subId)
  }

  /** True once no relay is still mid-handshake. */
  get allSettled() {
    return this.relayUrls.every((u) => this.status.get(u) !== 'connecting' && this.status.has(u))
  }

  /** Number of relays currently open. */
  get openUrls() {
    return this.relayUrls.filter((u) => this.status.get(u) === 'open')
  }

  closeAll() {
    for (const subId of [...this.subs.keys()]) this.close(subId)
    for (const [, ws] of this.sockets) {
      try {
        ws.close()
      } catch {
        /* noop */
      }
    }
    this.sockets.clear()
  }
}

export function isLikelyHexPubkey(str) {
  return /^[0-9a-f]{64}$/i.test(str.trim())
}

// --- Minimal bech32 (npub/nprofile) decoding -------------------------------
// Enough to turn a pasted npub1... into a hex pubkey for filtering/search,
// without pulling in a bech32 dependency.

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let chk = 1
  for (const v of values) {
    const b = chk >> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) {
      if ((b >> i) & 1) chk ^= GEN[i]
    }
  }
  return chk
}

function bech32HrpExpand(hrp) {
  const out = []
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5)
  out.push(0)
  for (const c of hrp) out.push(c.charCodeAt(0) & 31)
  return out
}

function bech32Decode(bechStr) {
  const str = bechStr.toLowerCase().trim()
  const pos = str.lastIndexOf('1')
  if (pos < 1 || pos + 7 > str.length) return null
  const hrp = str.slice(0, pos)
  const dataPart = str.slice(pos + 1)
  const data = []
  for (const c of dataPart) {
    const d = BECH32_CHARSET.indexOf(c)
    if (d === -1) return null
    data.push(d)
  }
  const check = bech32Polymod(bech32HrpExpand(hrp).concat(data))
  if (check !== 1) return null // invalid checksum
  return { hrp, data: data.slice(0, -6) }
}

function convertBits(data, fromBits, toBits, pad) {
  let acc = 0
  let bits = 0
  const out = []
  const maxv = (1 << toBits) - 1
  for (const value of data) {
    acc = (acc << fromBits) | value
    bits += fromBits
    while (bits >= toBits) {
      bits -= toBits
      out.push((acc >> bits) & maxv)
    }
  }
  if (pad && bits > 0) out.push((acc << (toBits - bits)) & maxv)
  return out
}

function toHex(bytes) {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Decodes npub1... to a 64-char hex pubkey. Returns null on failure. */
export function npubToHex(npub) {
  try {
    const decoded = bech32Decode(npub)
    if (!decoded || decoded.hrp !== 'npub') return null
    const bytes = convertBits(decoded.data, 5, 8, false)
    return toHex(bytes)
  } catch {
    return null
  }
}

/** Decodes nprofile1... to a 64-char hex pubkey (ignores relay hints in TLV). */
export function nprofileToHex(nprofile) {
  try {
    const decoded = bech32Decode(nprofile)
    if (!decoded || decoded.hrp !== 'nprofile') return null
    const bytes = convertBits(decoded.data, 5, 8, false)
    // TLV: type(1) length(1) value(length) ... — type 0 is the pubkey.
    let i = 0
    while (i < bytes.length) {
      const t = bytes[i]
      const l = bytes[i + 1]
      const v = bytes.slice(i + 2, i + 2 + l)
      if (t === 0 && v.length === 32) return toHex(v)
      i += 2 + l
    }
    return null
  } catch {
    return null
  }
}

function bech32Create(hrp, data) {
  const combined = data.concat(bech32CreateChecksum(hrp, data))
  return hrp + '1' + combined.map((d) => BECH32_CHARSET[d]).join('')
}

function bech32CreateChecksum(hrp, data) {
  const values = bech32HrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0])
  const mod = bech32Polymod(values) ^ 1
  const ret = []
  for (let p = 0; p < 6; p++) ret.push((mod >> (5 * (5 - p))) & 31)
  return ret
}

/** Encodes a 64-char hex pubkey to npub1... */
export function hexToNpub(hex) {
  try {
    const bytes = []
    for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16))
    const words = convertBits(bytes, 8, 5, true)
    return bech32Create('npub', words)
  } catch {
    return null
  }
}

/** Resolves any user-typed identity string to a hex pubkey, or null. */
export function resolveToHex(input) {
  const str = input.trim()
  if (isLikelyHexPubkey(str)) return str.toLowerCase()
  if (str.startsWith('npub1')) return npubToHex(str)
  if (str.startsWith('nprofile1')) return nprofileToHex(str)
  return null
}

export { DEFAULT_RELAYS }
