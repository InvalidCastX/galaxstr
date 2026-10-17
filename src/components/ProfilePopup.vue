<script setup>
import { computed, inject } from 'vue'
import { hexToNpub } from '../nostr.js'
import { avatarThumb } from '../image.js'
import { buildCardUrl } from '../relays.js'

const props = defineProps({
  node: { type: Object, required: true },
  nostrCardBaseUrl: { type: String, default: 'https://cardstr.pages.dev/#/p/' },
  relays: { type: Array, default: () => [] } // active relays, passed on so the card reads from the same ones
})
defineEmits(['close'])

const dataMode = inject('dataMode', computed(() => 'saver'))
const avatarSrc = computed(() => {
  if (!props.node.picture || dataMode.value === 'off') return null
  // The popup avatar renders a bit larger than a star (~56px), so ask
  // for a slightly bigger thumbnail than the in-galaxy one.
  return dataMode.value === 'full' ? props.node.picture : avatarThumb(props.node.picture, 96)
})

const npub = computed(() => hexToNpub(props.node.id) || props.node.id)
const shortNpub = computed(() => npub.value.slice(0, 12) + '…' + npub.value.slice(-6))
const cardUrl = computed(() => buildCardUrl(props.nostrCardBaseUrl, npub.value, props.relays))

const activityLabel = computed(() => {
  const n = props.node
  const parts = []
  if (n.noteCount) parts.push(`${n.noteCount} note${n.noteCount === 1 ? '' : 's'}`)
  if (n.replyCount) parts.push(`${n.replyCount} repl${n.replyCount === 1 ? 'y' : 'ies'}`)
  if (n.reactionsReceived) parts.push(`${n.reactionsReceived} reaction${n.reactionsReceived === 1 ? '' : 's'} received`)
  return parts.length ? parts.join(' · ') : 'No activity observed in this window'
})

function copyNpub() {
  navigator.clipboard?.writeText(npub.value).catch(() => {})
}
</script>

<template>
  <div class="popup" @click.stop>
    <button class="popup__close" @click="$emit('close')" aria-label="Close">✕</button>
    <p class="popup__eyebrow">User selected</p>

    <div class="popup__header">
      <div class="popup__avatar-wrap" :class="`ring--${node.color}`">
        <img
          v-if="avatarSrc"
          :src="avatarSrc"
          class="popup__avatar"
          loading="lazy"
          decoding="async"
          alt=""
          @error="$event.target.style.display = 'none'"
        />
        <span v-else class="popup__avatar-fallback">✦</span>
      </div>
      <div>
        <h3 class="popup__name">{{ node.name || 'Unnamed identity' }}</h3>
        <p v-if="node.nip05" class="popup__nip05">
          <span v-if="node.nip05Verified">✓</span> {{ node.nip05 }}
        </p>
      </div>
    </div>

    <dl class="popup__facts">
      <dt>npub</dt>
      <dd>
        <button class="popup__npub" @click="copyNpub" title="Copy full npub">{{ shortNpub }}</button>
      </dd>

      <dt>Observed activity</dt>
      <dd>{{ activityLabel }}</dd>

      <dt v-if="node.topHashtags?.length">Topics</dt>
      <dd v-if="node.topHashtags?.length">{{ node.topHashtags.map((t) => '#' + t).join(' ') }}</dd>
    </dl>

    <a class="popup__open" :href="cardUrl" target="_blank" rel="noopener noreferrer">Open Full NostrCard →</a>
  </div>
</template>

<style scoped>
.popup {
  position: relative;
  width: min(320px, 84vw);
  background: var(--bg-panel);
  backdrop-filter: blur(14px);
  border: 1px solid var(--hairline);
  border-radius: 14px;
  padding: 18px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
}

.popup__close {
  position: absolute;
  top: 10px;
  right: 10px;
  background: none;
  border: none;
  color: var(--dim);
  font-size: 14px;
  padding: 4px;
}

.popup__eyebrow {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--dim);
  letter-spacing: 0.02em;
}

.popup__header {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 14px;
}

.popup__avatar-wrap {
  width: 52px;
  height: 52px;
  border-radius: 50%;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-panel-solid);
  border: 1.5px solid currentColor;
  box-shadow: 0 0 10px 1px currentColor;
  flex-shrink: 0;
}
.ring--purple { color: var(--c-purple); }
.ring--green { color: var(--c-green); }
.ring--gold { color: var(--c-gold); }
.ring--blue { color: var(--c-blue); }
.ring--red { color: var(--c-red); }

.popup__avatar {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.popup__avatar-fallback {
  font-size: 22px;
}

.popup__name {
  margin: 0 0 2px;
  font-family: var(--font-display);
  font-size: 19px;
  font-weight: 500;
}

.popup__nip05 {
  margin: 0;
  font-size: 12.5px;
  color: var(--c-gold);
}

.popup__facts {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 10px;
  margin: 0 0 16px;
  font-size: 12.5px;
}
.popup__facts dt {
  color: var(--dim);
}
.popup__facts dd {
  margin: 0;
  color: var(--star-white);
}

.popup__npub {
  background: none;
  border: none;
  color: var(--star-white);
  font-family: var(--font-ui);
  font-size: 12.5px;
  padding: 0;
  text-decoration: underline dotted;
  text-underline-offset: 3px;
}

.popup__open {
  display: block;
  text-align: center;
  padding: 11px;
  border-radius: 8px;
  background: var(--star-white);
  color: var(--bg-void);
  font-weight: 600;
  font-size: 13.5px;
  text-decoration: none;
}
</style>
