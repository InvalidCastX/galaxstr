// embed.js — URL options for embedding Galaxstr in another app (iframe).
// Pure function (search string in, options out) so it's testable without a browser.
//
//   ?embed=1        skip the landing page + hide Galaxstr's own title (host app has its header)
//   ?landing=0      skip the landing page only   (also: ?skip=1)
//   ?orbit=npub1…   open straight into "Your Orbit" for that identity (npub / nprofile / hex)
//   ?relay=a&relay=b  already supported — pass the host app's relays
//
// Truthy values: 1, true, yes, on (or a bare ?embed). Falsy: 0, false, no, off.

const TRUE = new Set(['', '1', 'true', 'yes', 'on'])
const FALSE = new Set(['0', 'false', 'no', 'off'])

function flag(params, name) {
  if (!params.has(name)) return null
  const v = params.get(name).trim().toLowerCase()
  if (TRUE.has(v)) return true
  if (FALSE.has(v)) return false
  return null
}

export function parseEmbedParams(search) {
  let p
  try {
    p = new URLSearchParams(search || '')
  } catch {
    p = new URLSearchParams('')
  }
  const embed = flag(p, 'embed') === true
  const landing = flag(p, 'landing')
  const skip = flag(p, 'skip')
  // explicit ?landing=0 / ?skip=1 wins; ?landing=1 forces the landing page even in embed mode
  let skipLanding = embed
  if (skip !== null) skipLanding = skip
  if (landing !== null) skipLanding = !landing
  const orbit = (p.get('orbit') || '').trim()
  return { embed, skipLanding: skipLanding || !!orbit, orbit: orbit || null }
}
