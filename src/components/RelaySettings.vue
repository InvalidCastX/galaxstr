<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { parseRelay, relaysToSearch, MAX_RELAYS } from '../relays.js'

const props = defineProps({
  relays: { type: Array, required: true }, // currently active
  defaults: { type: Array, default: () => [] }, // from config.json
  status: { type: Object, default: () => ({}) } // url -> connecting | open | closed | error
})
const emit = defineEmits(['apply', 'close'])

// Edit a draft; nothing reconnects until "Apply".
const draft = ref([...props.relays])
const input = ref('')
const error = ref('')
const copied = ref(false)
const inputEl = ref(null)
const dialogEl = ref(null)

const changed = computed(() => draft.value.join('\n') !== props.relays.join('\n'))
const atDefaults = computed(() => draft.value.join('\n') === props.defaults.join('\n'))
const atLimit = computed(() => draft.value.length >= MAX_RELAYS)

function add() {
  error.value = ''
  const r = parseRelay(input.value)
  if (r.error) {
    error.value = r.error
    return
  }
  if (draft.value.includes(r.url)) {
    error.value = 'Already in the list'
    return
  }
  if (atLimit.value) {
    error.value = `Up to ${MAX_RELAYS} relays — each one adds traffic`
    return
  }
  draft.value.push(r.url)
  input.value = ''
}
function remove(url) {
  draft.value = draft.value.filter((r) => r !== url)
  error.value = ''
}
function resetDefaults() {
  draft.value = [...props.defaults]
  error.value = ''
}
function apply() {
  if (!draft.value.length) {
    error.value = 'Keep at least one relay'
    return
  }
  emit('apply', [...draft.value])
}

function statusOf(url) {
  // only meaningful for relays that were active when status was last reported
  return props.relays.includes(url) ? props.status[url] || 'idle' : 'idle'
}
const statusText = { open: 'Connected', connecting: 'Connecting…', closed: 'Unreachable', error: 'Unreachable', idle: 'Not connected yet' }
const prettyUrl = (u) => u.replace(/^wss:\/\//, '')

async function copyLink() {
  const url = location.origin + location.pathname + relaysToSearch(draft.value, location.search)
  try {
    await navigator.clipboard.writeText(url)
    copied.value = true
    setTimeout(() => (copied.value = false), 1800)
  } catch {
    error.value = 'Couldn’t copy — the address bar link has the same relays once applied'
  }
}

function onKey(e) {
  if (e.key === 'Escape') emit('close')
  // keep Tab inside the dialog
  if (e.key === 'Tab' && dialogEl.value) {
    const f = dialogEl.value.querySelectorAll('button:not([disabled]), input')
    if (!f.length) return
    const first = f[0]
    const last = f[f.length - 1]
    if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus())
    else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus())
  }
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  nextTick(() => inputEl.value?.focus())
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div ref="dialogEl" class="modal" role="dialog" aria-modal="true" aria-labelledby="relay-title">
      <button class="modal__close" @click="emit('close')" aria-label="Close">✕</button>
      <h2 id="relay-title" class="modal__title">Relays</h2>
      <p class="modal__hint">
        Galaxstr reads public events from these relays. Changing the list reloads the galaxy. The list is also
        kept in the page address, so you can share a link that opens with the same relays.
      </p>

      <ul class="relay-list scroll-thin">
        <li v-for="url in draft" :key="url" class="relay">
          <span class="relay__dot" :class="`relay__dot--${statusOf(url)}`" :title="statusText[statusOf(url)]"></span>
          <span class="relay__url">{{ prettyUrl(url) }}</span>
          <span class="relay__state">{{ statusText[statusOf(url)] }}</span>
          <button
            class="relay__remove"
            :disabled="draft.length <= 1"
            :aria-label="`Remove ${prettyUrl(url)}`"
            :title="draft.length <= 1 ? 'Keep at least one relay' : 'Remove'"
            @click="remove(url)"
          >
            ✕
          </button>
        </li>
      </ul>

      <div class="add">
        <input
          ref="inputEl"
          v-model="input"
          class="add__input"
          placeholder="relay.example.com or wss://…"
          autocapitalize="off"
          autocomplete="off"
          spellcheck="false"
          :disabled="atLimit"
          @keyup.enter="add"
        />
        <button class="btn" :disabled="atLimit || !input.trim()" @click="add">Add</button>
      </div>
      <p v-if="error" class="modal__error" role="alert">{{ error }}</p>

      <div class="modal__footer">
        <div class="modal__left">
          <button class="link" :disabled="atDefaults" @click="resetDefaults">Reset to defaults</button>
          <button class="link" @click="copyLink">{{ copied ? 'Copied ✓' : 'Copy share link' }}</button>
        </div>
        <button class="btn btn--primary" :disabled="!changed" @click="apply">Apply &amp; reload</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  background: rgba(3, 4, 10, 0.72);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  padding-bottom: max(16px, env(safe-area-inset-bottom));
}
.modal {
  position: relative;
  width: min(460px, 100%);
  max-height: 100%;
  overflow-y: auto;
  background: var(--bg-panel-solid);
  border: 1px solid var(--hairline);
  border-radius: 16px;
  padding: 22px 20px 18px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
}
.modal__close {
  position: absolute;
  top: 10px;
  right: 10px;
  width: 36px;
  height: 36px;
  border: none;
  background: none;
  color: var(--dim);
  font-size: 15px;
}
.modal__title {
  margin: 0 0 6px;
  font-family: var(--font-display);
  font-weight: 500;
  font-size: 22px;
}
.modal__hint {
  margin: 0 0 14px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--dim);
}
.relay-list {
  list-style: none;
  margin: 0 0 12px;
  padding: 0;
  max-height: 34vh;
  overflow-y: auto;
}
.relay {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 4px;
  border-bottom: 1px solid var(--hairline);
}
.relay__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--dim);
}
.relay__dot--open {
  background: var(--c-green);
  box-shadow: 0 0 6px var(--c-green);
}
.relay__dot--connecting {
  background: var(--c-gold);
}
.relay__dot--closed,
.relay__dot--error {
  background: var(--c-red);
}
.relay__url {
  flex: 1;
  min-width: 0;
  font-size: 13.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.relay__state {
  font-size: 11px;
  color: var(--dim);
  white-space: nowrap;
}
.relay__remove {
  width: 32px;
  height: 32px;
  border: none;
  background: none;
  color: var(--dim);
  font-size: 13px;
  border-radius: 8px;
}
.relay__remove:hover:not(:disabled) {
  color: var(--c-red);
}
.relay__remove:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.add {
  display: flex;
  gap: 8px;
}
.add__input {
  flex: 1;
  min-width: 0;
  background: var(--bg-void);
  border: 1px solid var(--hairline);
  border-radius: 10px;
  color: var(--star-white);
  padding: 10px 12px;
  font-size: 16px; /* 16px stops iOS zooming the page on focus */
  font-family: inherit;
}
.add__input:focus {
  outline: none;
  border-color: var(--c-purple);
}
.modal__error {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--c-red);
}
.modal__footer {
  margin-top: 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.modal__left {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
}
.btn {
  background: var(--bg-panel);
  border: 1px solid var(--hairline);
  color: var(--star-white);
  border-radius: 999px;
  padding: 9px 16px;
  font-size: 13px;
}
.btn--primary {
  background: var(--star-white);
  color: var(--bg-void);
  border-color: transparent;
  font-weight: 600;
}
.btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.link {
  background: none;
  border: none;
  padding: 6px 0;
  color: var(--c-purple);
  font-size: 12.5px;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.link:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
