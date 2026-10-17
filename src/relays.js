// relays.js — relay list handling: validation, URL (de)serialisation and
// persistence. Pure functions (storage / search string are passed in) so
// it's testable without a browser.
//
// Precedence at startup:  ?relay= in the URL  >  saved choice  >  config.json
//
// URL form is deliberately short and readable:
//   https://galaxstr.pages.dev/?relay=relay.damus.io&relay=nos.lol
// (wss:// is implied; ws:// is only accepted for localhost and kept explicit.)

export const MAX_RELAYS = 8
const STORAGE_KEY = 'galaxstr.relays'

function isLocalHost(h) {
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]'
}

/** -> { url } with a canonical wss://host[/path] string, or { error }. */
export function parseRelay(input) {
  let s = String(input ?? '').trim()
  if (!s) return { error: 'Enter a relay address' }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'wss://' + s
  let u
  try {
    u = new URL(s)
  } catch {
    return { error: 'That doesn’t look like a valid address' }
  }
  if (u.protocol !== 'wss:' && u.protocol !== 'ws:') return { error: 'Relays must start with wss://' }
  if (u.username || u.password) return { error: 'Remove the username/password from the address' }
  const local = isLocalHost(u.hostname)
  if (u.protocol === 'ws:' && !local) return { error: 'Use wss:// (secure) — plain ws:// only works for localhost' }
  if (!local && !u.hostname.includes('.')) return { error: 'That doesn’t look like a valid address' }
  const path = u.pathname.replace(/\/+$/, '')
  return { url: `${u.protocol}//${u.host}${path}` }
}

/** Validates + de-duplicates, preserving order, capped at MAX_RELAYS. */
export function cleanRelays(list) {
  const out = []
  for (const item of list || []) {
    const r = parseRelay(item)
    if (r.url && !out.includes(r.url)) out.push(r.url)
    if (out.length >= MAX_RELAYS) break
  }
  return out
}

/** Reads ?relay=a&relay=b (and ?relays=a,b) from a location.search string. */
export function relaysFromSearch(search) {
  try {
    const p = new URLSearchParams(search || '')
    const raw = [...p.getAll('relay'), ...p.getAll('relays').flatMap((v) => v.split(','))]
    return cleanRelays(raw)
  } catch {
    return []
  }
}

function shorten(url) {
  return url.startsWith('wss://') ? url.slice(6) : url
}
function encodeParam(v) {
  // keep ':' and '/' literal — they're legal in a query string and far more readable
  return encodeURIComponent(v).replace(/%3A/gi, ':').replace(/%2F/gi, '/')
}

/** Returns a new search string ('?...' or '') with relays set, other params kept. */
export function relaysToSearch(relays, currentSearch = '') {
  const p = new URLSearchParams(currentSearch || '')
  p.delete('relay')
  p.delete('relays')
  const parts = []
  const rest = p.toString()
  if (rest) parts.push(rest)
  for (const r of relays) parts.push('relay=' + encodeParam(shorten(r)))
  return parts.length ? '?' + parts.join('&') : ''
}

export function loadStoredRelays(storage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY)
    return raw ? cleanRelays(JSON.parse(raw)) : []
  } catch {
    return []
  }
}

/** Pass null to forget the saved choice (fall back to config defaults). */
export function saveStoredRelays(storage, list) {
  try {
    if (!storage) return
    if (list && list.length) storage.setItem(STORAGE_KEY, JSON.stringify(list))
    else storage.removeItem(STORAGE_KEY)
  } catch {
    /* private mode / quota — the URL still carries the setting */
  }
}
