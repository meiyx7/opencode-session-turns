import { Command, Plugin, Slot, Style, usePlugin } from "@opencode/plugin/gui"
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js"
import { Portal } from "solid-js/web"

// ---------------------------------------------------------------------------
// constants / helpers
// ---------------------------------------------------------------------------

const VERSION = "v26"
const HASH_PREFIX = "message-"
const DIAG_EVENT = "session-turns:diag"
const OPEN_EVENT = "session-turns:open"
const PIN_EVENT = "session-turns:pin"

// paging: a full load walks every page; a light refresh pulls just the newest
// page (new messages always land at the head of a desc listing).
const FULL_PAGE_LIMIT = 40
const FULL_PAGE_SIZE = 200
const LIGHT_PAGE_SIZE = 50

// Jump budgets.
//
// The host loads missing history asynchronously and retries a missing seek up
// to 12 times on its own. The plugin therefore does NOT poll the hash: it
// sets it once and waits. JUMP_CHAIN_MS is how long a single chain may run,
// JUMP_IDLE_MS how long the host may stay completely idle before the plugin
// assumes the chain died and starts a new one. Efficiency-first: the host
// pages with a 2s cooldown, so 6s of total silence means the seek was
// dropped (its machine starts inactive and ignores early seeks) - bounce
// and re-engage instead of waiting longer.
const JUMP_ROUNDS = 30
const JUMP_TOTAL_MS = 45000
const JUMP_CHAIN_MS = 20000
const JUMP_IDLE_MS = 6000
const JUMP_FIRST_IDLE_MS = 6000
const JUMP_TOGGLE_DWELL_MS = 220
const SAME_TARGET_WINDOW_MS = 800

// Prewarm politeness. Prewarming asks the host to seek the oldest message, so
// the host moves the scroll position; the plugin puts it back every frame, but
// only while nobody else is using the viewport.
const USER_IDLE_MS = 8000 // no human input for this long => prewarm may run
const EVENT_QUIET_MS = 1200 // an incoming message means the session is in use
const WARM_RETRY_WINDOW_MS = 120000 // auto-retry budget after a session opens
const WARM_RETRY_DELAY_MS = 1500

// ETA estimation. The host's paging machine runs on a fixed cadence (a hard
// 2s cooldown between pages, ~5 turns per page), and the plugin knows every
// turn's index from the server-side list - so remaining time is computable:
// remaining turns / measured turns-per-page x measured ms-per-page. Both
// rates are measured live and converge as pages land; the defaults only
// cover the first estimate.
const PAGE_MS_DEFAULT = 2000
const TURNS_PER_PAGE_DEFAULT = 5

// Filled by Rail.load()/jump() so the command palette can report diagnostics.
let lastTurnCount = 0
let lastNote = ""
let lastAlign = ""
let lastJumpID = ""

const firstLine = (message) => {
  const line = String(message?.text ?? "")
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.length > 0)
  if (line) return line
  const files = message?.files?.length ?? 0
  if (files > 0) return `[附件 ×${files}]`
  return "(空消息)"
}

const pad = (value) => String(value).padStart(2, "0")

const formatTime = (created) => {
  const date = new Date(created ?? 0)
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  if (sameDay) return `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  const wasYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()
  if (wasYesterday) return `昨天 ${pad(date.getHours())}:${pad(date.getMinutes())}`
  // Older turns need a date: a bare HH:mm is ambiguous in multi-day sessions.
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The app's own code reads this exact selector. The data-slot sits on the
// outer .scroll-view (overflow: hidden); only .scroll-view__viewport scrolls.
const findScroller = () =>
  document.querySelector('[data-slot="session-timeline-scroll"] > .scroll-view__viewport') ??
  document.querySelector('[data-slot="session-timeline-scroll"] [data-scrollable]') ??
  (() => {
    const row = document.querySelector("[data-message-id]")
    let node = row?.parentElement
    while (node) {
      const style = getComputedStyle(node)
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) return node
      node = node.parentElement
    }
    return undefined
  })()

// The app sets id="message-<id>" on every timeline row. Prefer that over the
// data attribute: Solid Router's own scrollToHash() uses getElementById too.
//
// IMPORTANT: `data-message-id` is set on assistant rows as well (they carry
// the id of the user message they belong to), so a naive lookup can return an
// assistant row and we would scroll to the reply instead of the question.
// Only the user message row counts as "found".
const findRow = (messageID) => {
  const anchored = document.getElementById(`${HASH_PREFIX}${messageID}`)
  if (anchored) return anchored
  const selector = `[data-message-id="${messageID.replace(/"/g, '\\"')}"]`
  for (const node of document.querySelectorAll(selector)) {
    if (node.getAttribute("data-timeline-row") === "UserMessage") return node
    if (node.querySelector('[data-slot="user-message-text"]')) return node
  }
  return undefined
}

const diagnostics = (ctx) => {
  const scroller = findScroller()
  const nodes = [...document.querySelectorAll("[data-message-id]")]
  const sample = nodes[0]?.getAttribute("data-message-id") ?? ""
  const target = lastJumpID ? ` · 目标 ${findRow(lastJumpID) ? "在" : "不在"} DOM` : ""
  const id = sample ? ` · 行ID ${sample.slice(0, 20)}` : ""
  let route = "(空)"
  try {
    route = ctx.router.path() || "(空)"
  } catch {}
  return `轮次 ${lastTurnCount} · 容器 ${scroller ? "OK" : "缺失"} · DOM ${nodes.length} 行${target}${id} · 路由 ${route} · hash ${window.location.hash || "(空)"}${lastAlign ? ` · ${lastAlign}` : ""}${lastNote ? ` · ${lastNote}` : ""}`
}

// The timeline's top is covered by the host's sticky header: the session title
// (z-30) plus a 16px gradient fade strip that sits right below it. The host
// parks a sought row flush against that band, which is why the bubble's top
// edge (and the highlight ring) used to be cut off.
//
// Instead of guessing a fixed offset, measure the band: every sticky element
// pinned to the top of the scrollport contributes its bottom edge.
const topInset = (scroller) => {
  const scTop = scroller.getBoundingClientRect().top
  let bottom = scTop
  for (const el of scroller.querySelectorAll(".sticky, [data-session-title]")) {
    if (!(el instanceof HTMLElement)) continue
    const style = getComputedStyle(el)
    if (style.position !== "sticky" && !el.hasAttribute("data-session-title")) continue
    const rect = el.getBoundingClientRect()
    if (rect.height === 0) continue
    if (rect.top > scTop + 4) continue // not pinned to the top
    bottom = Math.max(bottom, rect.bottom)
  }
  return bottom
}

// Places the message bubble (not the row) clear of the header band.
const alignBubble = (row) => {
  try {
    const sc = findScroller()
    if (!sc || !row.isConnected) return
    const bubble = row.querySelector('[data-slot="user-message-text"]') ?? row
    const inset = topInset(sc)
    const delta = bubble.getBoundingClientRect().top - (inset + 18)
    if (Math.abs(delta) > 2) sc.scrollTop += delta
    lastAlign = `inset ${Math.round(inset)} · delta ${Math.round(delta)}`
  } catch {}
}

// The host's own seek may finish after ours (it can even scroll smoothly),
// re-aligning the row flush under the header. Re-align a couple of times.
const alignAfterLand = (row) => {
  alignBubble(row)
  setTimeout(() => alignBubble(row), 450)
  setTimeout(() => alignBubble(row), 1000)
}

// The desktop app (2.2.6) routes through a memory history, so window.location is
// stuck at the asset path `oc://renderer/index.html` and is decoupled from the
// real route. Writing `#message-<id>` + firing popstate made the host parse
// `/index.html` as a route and throw a fatal "Unrecognised route!".
//
// The one safe path into the host router is its document-level link interceptor
// (Solid Router's `create` hook): a bubbling click on an <a> whose href is an
// internal route makes it call the memory router's navigate(). We build an <a>
// from the *real* route (ctx.router.path(), a valid /server/…/session/… path)
// plus `#message-<id>` and click it. The route parses fine, the location hash
// changes, and the host's own cursor machine pages in the history and seeks to
// the row. window.location is never touched, so nothing crashes.
const routePath = (ctx) => {
  let path = ""
  try {
    path = ctx.router.path() || ""
  } catch {}
  return path.startsWith("/") ? path : ""
}

// Clicks an internal route link; the host's link interceptor turns it into
// memory-router navigate(). `href` is a path, optionally with a #message-<id>.
const clickRoute = (href) => {
  const anchor = document.createElement("a")
  anchor.setAttribute("href", href)
  // Match the host's own hash jumps: replace instead of push, and skip the
  // router's window.scrollTo(0,0) while the row is still unmounted.
  anchor.setAttribute("replace", "")
  anchor.setAttribute("noscroll", "")
  anchor.style.display = "none"
  document.body.appendChild(anchor)
  try {
    anchor.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, view: window }),
    )
  } finally {
    anchor.remove()
  }
}

// ---------------------------------------------------------------------------
// styles
// ---------------------------------------------------------------------------

const CSS = `
.sr-rail {
  position: fixed;
  top: 50%;
  transform: translateY(-50%);
  right: 14px;
  max-height: 66vh;
  width: 16px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 6px 2px;
  overflow: hidden;
  z-index: 400;
  border-radius: 10px;
  border: 1px solid transparent;
  color: var(--text-base, currentColor);
  background: transparent;
  transition: width .18s ease, background .18s ease, box-shadow .18s ease, border-color .18s ease;
}
.sr-rail[data-open="true"] {
  width: 340px;
  padding: 10px;
  justify-content: flex-start;
  background: var(--surface-base, rgba(24,24,26,.86));
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border-color: rgba(127,127,127,.25);
  box-shadow: 0 8px 32px rgba(0,0,0,.28);
}
.sr-head {
  position: relative;
  display: none;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 2px 8px;
  margin-bottom: 6px;
  border-bottom: 1px solid rgba(127,127,127,.2);
  flex-shrink: 0;
}
.sr-rail[data-open="true"] .sr-head { display: flex; }
.sr-title { font-size: 12px; opacity: .6; white-space: nowrap; }
.sr-title.sr-progress {
  opacity: .95;
  color: rgba(255,170,60,.95);
  font-variant-numeric: tabular-nums;
}
/* determinate ETA bar (jumping/prewarming): sits under the header text */
.sr-eta-bar {
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: 0;
  height: 2px;
  border-radius: 1px;
  background: rgba(127,127,127,.18);
  overflow: hidden;
}
.sr-eta-fill {
  display: block;
  height: 100%;
  width: 0;
  border-radius: 1px;
  background: rgba(255,170,60,.9);
  transition: width .4s ease;
}
/* indeterminate shimmer while no target position is known yet */
.sr-eta-bar[data-live="false"] .sr-eta-fill {
  width: 30%;
  animation: srSlide 1.2s ease-in-out infinite;
}
@keyframes srSlide {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(430%); }
}
@media (prefers-reduced-motion: reduce) {
  .sr-eta-bar[data-live="false"] .sr-eta-fill { animation: none; width: 100%; opacity: .4; }
}
.sr-head-actions { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
.sr-iconbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  border-radius: 4px;
  opacity: .5;
}
.sr-iconbtn svg { width: 13px; height: 13px; }
.sr-iconbtn:hover { opacity: 1; background: var(--surface-base-hover, rgba(127,127,127,.14)); }
.sr-iconbtn[data-on="true"] { opacity: .95; color: rgba(255,170,60,.95); }
.sr-iconbtn:focus-visible { outline: 1px solid currentColor; outline-offset: -1px; }
/* search box */
.sr-search {
  position: relative;
  flex-shrink: 0;
  margin: 0 0 6px;
}
.sr-search-input {
  width: 100%;
  box-sizing: border-box;
  height: 26px;
  padding: 0 24px 0 8px;
  border: 1px solid rgba(127,127,127,.25);
  border-radius: 6px;
  background: color-mix(in srgb, currentColor 6%, transparent);
  color: inherit;
  font: inherit;
  font-size: 12px;
  outline: none;
  transition: border-color .12s ease, box-shadow .12s ease;
}
.sr-search-input::placeholder { color: currentColor; opacity: .4; }
.sr-search-input:focus {
  border-color: rgba(255,170,60,.6);
  box-shadow: 0 0 0 2px rgba(255,170,60,.14);
}
.sr-search-clear {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  opacity: .5;
}
.sr-search-clear:hover { opacity: 1; background: var(--surface-base-hover, rgba(127,127,127,.14)); }
/* keyboard cursor (↑/↓) */
.sr-turn[data-cursor="true"] { background: var(--surface-base-hover, rgba(127,127,127,.14)); }
.sr-close {
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13px;
  line-height: 1;
  padding: 2px 7px;
  border-radius: 4px;
  cursor: pointer;
  opacity: .5;
  flex-shrink: 0;
}
.sr-close:hover { opacity: 1; background: var(--surface-base-hover, rgba(127,127,127,.14)); }
/* the scrollable list; the header stays fixed above it.
   The collapsed rail must NOT be a scroll container: centering the content
   inside a scroller overflows in both directions, so the browser clamps the
   scroll offset and the list snaps to the top/bottom when the panel opens. */
.sr-list {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  overflow: hidden;
  scrollbar-width: none;
}
.sr-rail[data-open="true"] .sr-list {
  justify-content: flex-start;
  gap: 1px;
  overflow-y: auto;
  scrollbar-width: thin;
}
.sr-list::-webkit-scrollbar { display: none; }
.sr-rail[data-open="true"] .sr-list::-webkit-scrollbar { display: block; width: 8px; }
.sr-list::-webkit-scrollbar-track { background: transparent; }
.sr-rail[data-open="true"] .sr-list::-webkit-scrollbar-thumb {
  background: rgba(127,127,127,.35);
  border-radius: 4px;
}
.sr-turn {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  width: 100%;
  min-height: 14px;
  flex-shrink: 0;
  cursor: pointer;
  background: transparent;
  border: 0;
  padding: 0;
  color: inherit;
  font: inherit;
  border-radius: 4px;
}
/* expanded: dash flips to a left-side indicator, content reads left-to-right */
.sr-rail[data-open="true"] .sr-turn {
  flex-direction: row-reverse;
  justify-content: flex-start;
  gap: 9px;
  padding: 5px 8px;
  min-height: 0;
  border-radius: 6px;
}
.sr-turn:focus-visible, .sr-close:focus-visible { outline: 1px solid currentColor; outline-offset: -1px; }
.sr-dash {
  display: block;
  width: 10px;
  height: 2px;
  border-radius: 1px;
  background: currentColor;
  opacity: .28;
  flex-shrink: 0;
  transition: opacity .12s ease, width .12s ease, height .12s ease;
}
.sr-turn:hover .sr-dash,
.sr-turn[data-active="true"] .sr-dash { opacity: .95; width: 18px; }
.sr-rail[data-open="true"] .sr-dash { width: 3px; height: 16px; }
.sr-rail[data-open="true"] .sr-turn:hover .sr-dash,
.sr-rail[data-open="true"] .sr-turn[data-active="true"] .sr-dash { width: 3px; height: 22px; }
.sr-text {
  display: none;
  margin-right: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.5;
  text-align: right;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 300px;
  opacity: .45;
  background: transparent;
}
.sr-rail[data-open="true"] .sr-text {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  flex: 1;
  min-width: 0;
  margin: 0;
  padding: 0;
  text-align: left;
  white-space: normal;
  line-height: 1.45;
  max-width: none;
  opacity: .8;
}
.sr-num, .sr-time {
  opacity: .55;
  margin-right: 6px;
  font-variant-numeric: tabular-nums;
}
.sr-turn:hover { background: var(--surface-base-hover, rgba(127,127,127,.14)); }
.sr-rail[data-open="true"] .sr-turn:hover .sr-text,
.sr-rail[data-open="true"] .sr-turn[data-active="true"] .sr-text { opacity: 1; }
.sr-turn[data-active="true"] { font-weight: 500; }
/* the turn currently being jumped to */
.sr-turn[data-busy="true"] { background: rgba(255,170,60,.12); }
.sr-turn[data-busy="true"] .sr-dash {
  opacity: 1;
  width: 3px;
  height: 22px;
  background: rgba(255,170,60,.95);
  animation: srBusy 1s ease-in-out infinite;
}
.sr-turn[data-busy="false"] .sr-dash { animation: none; }
@keyframes srBusy {
  0%, 100% { opacity: .35; }
  50% { opacity: 1; }
}
/* pulse a landed bubble: an INSET ring, so it follows the bubble's own
   border-radius and can never be clipped by an ancestor that clips overflow
   (the timeline rows do) - an outline/box-shadow drawn outside the bubble
   loses its top edge exactly where the row clips. */
.sr-flash-ring { animation: srRing 1.8s ease-out 1; }
@keyframes srRing {
  0% {
    box-shadow: inset 0 0 0 2px rgba(255,170,60,.95), inset 0 0 26px rgba(255,170,60,.30);
  }
  55% {
    box-shadow: inset 0 0 0 2px rgba(255,170,60,.40), inset 0 0 14px rgba(255,170,60,.12);
  }
  100% {
    box-shadow: inset 0 0 0 2px rgba(255,170,60,0), inset 0 0 0 rgba(255,170,60,0);
  }
}
.sr-badge {
  font-size: 10px;
  line-height: 1.4;
  padding: 0 5px;
  border-radius: 4px;
  color: rgba(255,170,60,.95);
  background: rgba(255,170,60,.14);
  border: 1px solid rgba(255,170,60,.35);
  flex-shrink: 0;
  white-space: nowrap;
}
.sr-note {
  display: none;
  font-size: 11px;
  opacity: .4;
  padding: 2px;
}
.sr-rail[data-open="true"] .sr-note { display: block; }
.sr-foot {
  flex-shrink: 0;
  font-size: 11px;
  line-height: 1.5;
  color: rgba(255,170,60,.92);
  padding: 6px 2px 0;
  margin-top: 6px;
  border-top: 1px solid rgba(127,127,127,.2);
  white-space: pre-wrap;
  max-height: 64px;
  overflow: hidden;
}
.sr-status {
  position: fixed;
  right: 42px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 401;
  font-size: 11px;
  line-height: 1.5;
  padding: 4px 9px;
  border-radius: 6px;
  background: var(--background-strong, rgba(0,0,0,.82));
  color: var(--text-base, #fff);
  border: 1px solid rgba(127,127,127,.25);
  white-space: pre-wrap;
  max-width: 260px;
}
/* Reduced motion: keep the signals (colors, widths) but drop the animation. */
@media (prefers-reduced-motion: reduce) {
  .sr-rail, .sr-dash, .sr-text { transition: none !important; }
  .sr-turn[data-busy="true"] .sr-dash { animation: none !important; opacity: 1 !important; }
  .sr-flash-ring { animation: none !important; box-shadow: inset 0 0 0 2px rgba(255,170,60,.5) !important; }
}
`

// ---------------------------------------------------------------------------
// rail
// ---------------------------------------------------------------------------

function Rail(props) {
  const ctx = usePlugin()
  const [turns, setTurns] = createSignal([])
  const [active, setActive] = createSignal("")
  const [open, setOpen] = createSignal(false)
  const [note, setNote] = createSignal("")
  const [status, setStatus] = createSignal("")
  // Search box over the turn list; empty means show everything.
  const [query, setQuery] = createSignal("")
  // Pinned panels stay open when the pointer leaves (toggle: ⌘⌥P / /turns pin).
  const [pinned, setPinned] = createSignal(false)
  // Jump progress. While `jumping` is true the panel stays pinned open and the
  // header reports what the host is doing; `busyID` marks the target row.
  const [jumping, setJumping] = createSignal(false)
  const [jumpPages, setJumpPages] = createSignal(0)
  const [jumpElapsed, setJumpElapsed] = createSignal(0)
  const [jumpChain, setJumpChain] = createSignal(0)
  // Live ETA for the running jump/prewarm, in seconds (null = not computable).
  const [jumpEta, setJumpEta] = createSignal(null)
  // Progress toward the target, 0..1 (null = target position unknown).
  const [jumpProgress, setJumpProgress] = createSignal(null)
  const [busyID, setBusyID] = createSignal("")

  // ---- turn cache ---------------------------------------------------------
  // Object identity is kept stable across refreshes so Solid's <For> reuses
  // existing DOM instead of rebuilding the whole list on every update.
  const cache = new Map()
  let loadToken = 0
  let loadingActive = false
  let pendingBump = false
  let loadedFor = ""
  let lightTimer
  // Viewport-intent bookkeeping (see "user viewport intent" below). Prewarm
  // drives the host's seek machine, which moves the scroll position; it may
  // only do that while nobody else is using the viewport, so these record when
  // the human last drove it and when the host last pushed a message event.
  let userActiveUntil = 0
  let pointerHeld = false
  let pointerHeldAt = 0
  let lastEventAt = 0

  // Prewarm bookkeeping. Declared up here because load() resets it, and load()
  // can run before the prewarm section below is reached.
  let warmToken = 0
  let warmedFor = ""
  // Set when a prewarm gave up without reaching the oldest turn (the host never
  // engaged). The auto-resume effect must not retry it in a loop; an explicit
  // hover or a fresh full load still may.
  let warmBlockedFor = ""
  let warmRetryTimer
  let warmRetryUntil = 0
  let warmFailures = 0

  const sessionID = () => props.session()?.id

  const publish = () => {
    const list = [...cache.values()].sort((a, b) => a.created - b.created)
    const prev = untrack(turns)
    // Skip the signal write when nothing changed; <For> diffs by reference.
    if (prev.length === list.length && prev.every((item, i) => item === list[i])) return
    setTurns(list)
    lastTurnCount = list.length
  }

  const upsert = (item) => {
    const existing = cache.get(item.id)
    if (existing && existing.created === item.time && existing.text === item.text) return
    cache.set(item.id, { id: item.id, created: item.time, text: item.text })
  }

  const fetchPage = async (id, limit, cursor) => {
    // The server rejects `cursor` together with `order`
    // (InvalidCursorError: "Cursor cannot be combined with order").
    // The cursor itself already encodes the original order/direction,
    // so only the first page declares order: "desc".
    const params = cursor
      ? { sessionID: id, type: "user", limit, cursor }
      : { sessionID: id, type: "user", limit, order: "desc" }
    return await ctx.client.message.list(params)
  }

  // Oldest-turn probe: one cheap `order:"asc", limit:1` request that lets
  // prewarming start immediately on session open, without waiting for the
  // full desc list to walk every page (the oldest turn is on the LAST page).
  // Fired once per full load, in parallel with the list walk.
  let probeFor = ""
  let oldestProbe = ""
  let probePromise = null
  const probeOldest = async (id) => {
    // A second call while the first is still in flight must JOIN it, not
    // return the (still empty) result - otherwise every caller after the first
    // sees "no oldest turn" and the early-warm path never fires.
    if (probeFor === id) return probePromise ?? oldestProbe
    probeFor = id
    oldestProbe = ""
    probePromise = (async () => {
      try {
        const res = await ctx.client.message.list({ sessionID: id, type: "user", limit: 1, order: "asc" })
        // A newer probe (session switch) owns the slot now.
        if (probeFor === id) oldestProbe = res?.data?.[0]?.id ?? ""
      } catch {}
      return oldestProbe
    })()
    return probePromise
  }

  // Session whose turn list was walked to the end. Until then `turns()[0]` is
  // merely the oldest turn of the pages fetched SO FAR, so treating it as "the
  // oldest turn" makes prewarm target a message that is not actually the head
  // of the history (and lets a short-looking list report "already warm").
  let listCompleteFor = ""

  const load = async (id, mode) => {
    const token = ++loadToken
    loadingActive = true
    // A full (re)load means the host store may be cold again (session open or
    // server rebuild): invalidate the prewarm marker so it runs once more.
    if (mode === "full") {
      warmedFor = ""
      warmBlockedFor = ""
      warmFailures = 0
      // Re-open a retry window: the timeline may not be mounted yet, and
      // maybePrewarm() refuses to seek before it is (the host drops such seeks).
      warmRetryUntil = Date.now() + WARM_RETRY_WINDOW_MS
    }
    let error = ""
    // Fire the oldest-turn probe immediately in full mode (parallel with the
    // list walk) so prewarm can start before the list finishes.
    if (mode === "full") void probeOldest(id)
    try {
      let cursor
      const pages = mode === "full" ? FULL_PAGE_LIMIT : 1
      const limit = mode === "full" ? FULL_PAGE_SIZE : LIGHT_PAGE_SIZE
      let cleared = mode !== "full"
      for (let page = 0; page < pages; page++) {
        let response
        try {
          response = await fetchPage(id, limit, cursor)
        } catch (cause) {
          error = String(cause?.message ?? cause)
          break
        }
        // Superseded by a newer load (or a session switch): drop this page
        // instead of polluting the new session's cache with stale ids.
        if (token !== loadToken) return
        // Full mode clears only after the first page succeeded, so a server
        // error never blanks out the rail (v10's hard-won lesson).
        if (!cleared) {
          cache.clear()
          cleared = true
        }
        let fresh = 0
        for (const message of response?.data ?? []) {
          if (cache.has(message.id)) continue
          upsert({ id: message.id, time: message.time?.created ?? 0, text: firstLine(message) })
          fresh++
        }
        // Publish page by page: long sessions appear progressively instead of
        // popping in all at once after every page has been fetched.
        publish()
        const next = response?.cursor?.next
        // The walk reached the end of the history: `turns()[0]` is now the real
        // oldest turn and prewarm may use it as its target.
        if (mode === "full" && (!next || fresh === 0)) listCompleteFor = id
        if (!next || fresh === 0) break
        cursor = next
      }
    } finally {
      // A newer load (session switch / shutdown reload) owns the shared state
      // now. Writing `loadedFor`/`note` here would pin them to the OLD session
      // and make every later prewarm/resume guard fail on a stale id.
      if (token === loadToken) {
        loadingActive = false
        loadedFor = id
        lastNote = error
        setNote(cache.size === 0 ? error || "暂无用户消息" : "")
      }
      // A message arrived while a full load was running: catch up now.
      if (pendingBump) {
        pendingBump = false
        scheduleLight()
      }
      // Prewarm EVERY session as soon as its full turn list has loaded - the
      // host's seek machine drops seeks issued before the timeline is ready,
      // and an 8-turn session used to hit exactly that window on first click
      // (12s of dead air). Short sessions cost at most one extra host page.
      // With the asc probe, start as soon as the oldest turn id is known -
      // even if the desc list walk is still in flight (its cache keeps
      // filling via the event-driven light refresh).
      if (mode === "full" && !error && id === untrack(sessionID) && cache.size >= 1) {
        setTimeout(() => maybePrewarm(), 400)
      } else if (mode === "full" && !error && id === untrack(sessionID)) {
        // List walk still needed the first page? probeOldest may already have
        // resolved; give prewarm a chance as soon as both are ready.
        void probeOldest(id).then((oldest) => {
          if (oldest && id === untrack(sessionID) && !warmedFor && !warmBlockedFor) {
            setTimeout(() => maybePrewarm(), 400)
          }
        })
      }
    }
  }

  // ---- event-driven refresh (replaces the 5s full-list polling) -----------
  // The SDK shares one SSE connection with the host; consuming it here is a
  // second iterator over the same stream, not a second connection. Events are
  // debounced into a single-page light refresh, so streaming bursts cost
  // nothing beyond a few cheap `type` comparisons per event.
  const scheduleLight = () => {
    if (lightTimer) return
    lightTimer = setTimeout(() => {
      lightTimer = undefined
      const id = untrack(sessionID)
      if (id) void load(id, "light")
    }, 300)
  }

  const bump = (eventSessionID) => {
    // Only the session currently shown matters; ignore everything else.
    if (!eventSessionID || eventSessionID !== untrack(sessionID)) return
    if (loadingActive) {
      pendingBump = true
      return
    }
    scheduleLight()
  }

  const handleEvent = (event) => {
    const type = event?.type
    if (type === "message.updated" || type === "message.removed") {
      // Message traffic in the *current* session means it is in use: prewarm
      // must not move the viewport under an active conversation.
      if (event?.data?.sessionID === untrack(sessionID)) lastEventAt = Date.now()
    }
    if (type === "message.updated") {
      const data = event?.data ?? {}
      const info = data.info
      // Fast path: the payload carries the message itself, so a new user turn
      // shows up instantly; the debounced light refresh reconciles the rest.
      if (info?.role === "user" && info?.id) {
        upsert({ id: info.id, time: info.time?.created ?? 0, text: firstLine(info) })
        publish()
      }
      bump(data.sessionID)
    } else if (type === "message.removed") {
      const data = event?.data ?? {}
      if (data.messageID && cache.delete(data.messageID)) publish()
      bump(data.sessionID)
    } else if (type === "location.shutdown") {
      // Server rebuilt: do one full reload of the current session.
      const id = untrack(sessionID)
      if (id && loadedFor === id) void load(id, "full")
    }
  }

  onMount(() => {
    let stopped = false
    let attempt = 0
    let retryTimer
    const run = async () => {
      while (!stopped) {
        const stream = ctx.client.event.subscribe()
        const iterator = stream[Symbol.asyncIterator]()
        try {
          while (!stopped) {
            const next = await iterator.next()
            if (next.done) break
            attempt = 0
            handleEvent(next.value)
          }
        } catch {}
        // iterator.return() cancels the SSE reader (the SDK's generator
        // finally-block); errors from it are irrelevant at this point.
        try {
          await iterator.return?.()
        } catch {}
        if (stopped) break
        attempt++
        await sleep(Math.min(2000 * attempt, 15000))
      }
    }
    void run()
    onCleanup(() => {
      stopped = true
      clearTimeout(retryTimer)
      if (lightTimer) clearTimeout(lightTimer)
      if (warmRetryTimer) clearTimeout(warmRetryTimer)
      warmRetryTimer = undefined
    })
  })

  createEffect(() => {
    const id = sessionID()
    if (!id) return
    untrack(() => {
      if (loadedFor !== id) {
        // Invalidate anything in flight for the previous session first, so its
        // finally-block can't write `loadedFor`/`note` for the wrong session.
        loadToken++
        loadingActive = false
        pendingBump = false
        cache.clear()
        setTurns([])
        setActive("")
        lastNavID = ""
        void load(id, "full")
      }
    })
  })

  // ---- active-turn tracking ----------------------------------------------
  // Driven by scroll events (captured at document level so it also sees the
  // real scroller without querying first) plus one rAF-throttled pass. An
  // IntersectionObserver on the timeline rows replaces the old 1.5s interval:
  // a row leaving the sentinel line at the top of the viewport means the turn
  // under it became active, with zero work when nothing moves (and none at
  // all in a background window, where rAF is throttled to zero).
  let scrollerCache
  const scroller = () => {
    if (scrollerCache?.isConnected) return scrollerCache
    scrollerCache = findScroller()
    return scrollerCache
  }

  // Rows already wired to the observer, keyed by element so history paging
  // (rows mounting/unmounting) never re-observes the same node.
  const observed = new WeakSet()
  let rowObserver
  const ensureObserver = () => {
    if (rowObserver) return rowObserver
    rowObserver = new IntersectionObserver(
      (entries) => {
        // Any intersection change along the sentinel line can shift which turn
        // is topmost; recompute from the DOM (rAF-throttled, cheap).
        if (entries.length === 0) return
        scheduleTrack()
      },
      { rootMargin: "-40px 0px 0px 0px", threshold: 0 },
    )
    return rowObserver
  }
  // Wire up rows that appeared since the last pass. Called from trackActive,
  // so it only runs while the document is actually scrolling (rAF-gated).
  const observeRows = () => {
    const observer = ensureObserver()
    for (const row of document.querySelectorAll("[data-message-id]")) {
      if (!observed.has(row)) {
        observed.add(row)
        observer.observe(row)
      }
    }
  }

  const trackActive = () => {
    const sc = scroller()
    if (!sc) return
    const rows = sc.querySelectorAll("[data-message-id]")
    if (rows.length === 0) return
    const top = sc.getBoundingClientRect().top + 40
    for (const row of rows) {
      if (row.getBoundingClientRect().bottom >= top) {
        const id = row.getAttribute("data-message-id")
        if (id && id !== active()) setActive(id)
        break
      }
    }
  }

  let rafPending = false
  const scheduleTrack = () => {
    if (rafPending) return
    rafPending = true
    requestAnimationFrame(() => {
      rafPending = false
      trackActive()
      observeRows()
    })
  }

  onMount(() => {
    const onScroll = () => scheduleTrack()
    document.addEventListener("scroll", onScroll, true)
    // One slow liveness pass only while the tab is visible: catches rows that
    // mount without a scroll event and reconnects after DOM swaps, without
    // burning cycles in background windows (rAF never fires there, and the
    // interval self-pauses via document.hidden).
    const fallback = setInterval(() => {
      if (document.hidden) return
      scheduleTrack()
    }, 4000)
    onCleanup(() => {
      document.removeEventListener("scroll", onScroll, true)
      clearInterval(fallback)
      rowObserver?.disconnect()
    })
  })

  // ---- status flash -------------------------------------------------------
  // A sequence guard so a slow timeout from an earlier flash can never clear a
  // newer message.
  let flashSeq = 0
  const flash = (text, ms = 2600) => {
    const seq = ++flashSeq
    setStatus(text)
    setTimeout(() => {
      if (seq === flashSeq) setStatus("")
    }, ms)
  }

  // ---- open / close interactions ------------------------------------------
  onMount(() => {
    const onKey = (event) => {
      if (event.key !== "Escape") return
      // During a long jump Esc cancels the jump first and keeps the panel open,
      // so the progress display doesn't vanish mid-flight.
      if (untrack(jumping)) {
        cancelJump()
        event.stopPropagation()
        return
      }
      if (untrack(open)) {
        // Unpin first when pinned; a second Esc then closes the panel.
        if (untrack(pinned)) {
          setPinned(false)
        } else {
          setOpen(false)
        }
        // Only swallow Esc while the rail is actually open, so the host keeps
        // its own Escape handling the rest of the time.
        event.stopPropagation()
      }
    }
    const onPointerDown = (event) => {
      if (!untrack(open)) return
      if (untrack(pinned)) return
      const path = event.composedPath?.() ?? []
      const inside = path.some((node) => node instanceof Element && node.closest?.(".sr-rail"))
      if (!inside) setOpen(false)
    }
    window.addEventListener("keydown", onKey, true)
    document.addEventListener("pointerdown", onPointerDown, true)
    onCleanup(() => {
      window.removeEventListener("keydown", onKey, true)
      document.removeEventListener("pointerdown", onPointerDown, true)
    })
  })

  onMount(() => {
    const onDiag = () => flash(`${VERSION} · ${diagnostics(ctx)}`)
    // /turns toggles the panel; ⌘⌥P / the pin button toggles "pinned" (stay
    // open when the pointer leaves). Esc / outside click / × still close an
    // unpinned panel.
    const onOpen = () => {
      setOpen((value) => !value)
      maybePrewarm()
    }
    const onPin = () => {
      setPinned((value) => !value)
      if (!untrack(open)) {
        setOpen(true)
        maybePrewarm()
      }
    }
    window.addEventListener(DIAG_EVENT, onDiag)
    window.addEventListener(OPEN_EVENT, onOpen)
    window.addEventListener(PIN_EVENT, onPin)
    onCleanup(() => {
      window.removeEventListener(DIAG_EVENT, onDiag)
      window.removeEventListener(OPEN_EVENT, onOpen)
      window.removeEventListener(PIN_EVENT, onPin)
    })
    // No startup toast: the plugin should be invisible when everything works.
  })

  // ---- jump ----------------------------------------------------------------
  // The memory router's hash is invisible to us (window.location is stale), so
  // track the last id we navigated to in order to force a hash change each round.
  let lastNavID = ""
  let jumpToken = 0
  let lastJumpAt = 0
  let lastJumpTurnID = ""
  // After any navigation the host is scrolling/seeking; a prewarm must not
  // steal the hash back during that window (it would cancel the seek and the
  // viewport would snap back - the "jitter" symptom).
  let jumpQuietUntil = 0

  // Brief highlight on the message bubble. The timeline row spans the whole
  // width, so tinting it looks like a stray orange band. The visible bubble is
  // `[data-slot="user-message-text"]` (background + 10px radius); its parent
  // `user-message-body` is only a layout column. An outline + glow hugs the
  // bubble's own shape without altering its background.
  const pulse = (row) => {
    try {
      const target =
        row.querySelector('[data-slot="user-message-text"]') ??
        row.querySelector('[data-slot="user-message-body"]') ??
        row
      target.classList.remove("sr-flash-ring")
      void target.offsetWidth // restart the animation when re-pulsing the same node
      target.classList.add("sr-flash-ring")
      setTimeout(() => target.classList.remove("sr-flash-ring"), 1900)
    } catch {}
  }

  // Oldest turn that is currently mounted (i.e. already paged in), used as a
  // safe "different id" to toggle the router hash so it re-runs its seek.
  const oldestLoadedTurn = () => {
    for (const t of turns()) if (findRow(t.id)) return t
    return undefined
  }

  const navTo = (path, id) => {
    clickRoute(`${path}#${HASH_PREFIX}${id}`)
    lastNavID = id
  }

  // Navigates to the session WITHOUT a hash. The host ignores a hash value it
  // already holds, and an intermediate "bounce" through another turn can be
  // coalesced away when two clicks land close together - which left the jump
  // re-sending the same ignored hash for 30s ("0% · 还需 ~1s · 31s").
  // Clearing the hash first guarantees the next seek is a fresh value.
  const navClear = (path) => {
    clickRoute(path)
    lastNavID = ""
  }

  // Cheap fingerprint of the mounted timeline rows. Paging in older history
  // prepends rows, so a changed fingerprint means the host did real work and
  // the next hash toggle can be sent immediately.
  const rowSignature = () => {
    const sc = scroller()
    const rows = sc?.querySelectorAll("[data-message-id]") ?? []
    if (rows.length === 0) return "0"
    const first = rows[0].getAttribute("data-message-id") ?? ""
    const last = rows[rows.length - 1].getAttribute("data-message-id") ?? ""
    return `${rows.length}:${first}:${last}`
  }

  // Waits until the target row is mounted.
  //
  // Resolves with the row on success, or null when the host stopped making
  // progress (its own seek chain ran out) or the timeout hit. Crucially it
  // does NOT resolve just because rows appeared: the host may still be
  // fetching the rest of the history for this target, and interrupting it
  // (by toggling the hash) is what made deep jumps crawl one page per click.
  //
  // onKick covers the cold-start case: the host's seek machine starts
  // inactive and DROPS a seek issued before the timeline is ready (worst on
  // short sessions, which never used to prewarm). When nothing at all has
  // happened for KICK_AFTER_MS, it is called once to bounce the hash and
  // re-engage the host; then the normal idle limits apply.
  const waitForRow = (messageID, token, timeout, onPage, onKick) =>
    new Promise((resolve) => {
      let done = false
      let observer
      let poll
      let timer
      const started = Date.now()
      const baseline = rowSignature()
      let lastSig = baseline
      let lastChange = started
      let pages = 0
      let kicked = false
      // The cold-start kick bounces the hash, which changes the mounted rows
      // without the host paging anything. Counting that as a page corrupted
      // both the page counter and the ETA cadence, so skip the next change.
      let skipNextPage = false
      const KICK_AFTER_MS = 4000
      const finish = (row) => {
        if (done) return
        done = true
        try {
          observer?.disconnect()
        } catch {}
        clearInterval(poll)
        clearTimeout(timer)
        resolve(row ?? null)
      }
      const check = (full) => {
        if (token !== jumpToken) return finish(null)
        // Observer callbacks use the cheap id lookup; only the poll pays for the
        // data-attribute fallback (a full scan) and the row fingerprint.
        const row = full ? findRow(messageID) : document.getElementById(`${HASH_PREFIX}${messageID}`)
        if (row) return finish(row)
        if (!full) return
        const sig = rowSignature()
        const now = Date.now()
        if (sig !== lastSig) {
          lastSig = sig
          lastChange = now
          if (skipNextPage) {
            skipNextPage = false
            return
          }
          pages++
          onPage?.(pages)
          return
        }
        // Nothing has changed for a while: the host has no more history in
        // flight for this target. Before the first page lands we are even more
        // patient - the initial fetch can take seconds, and bouncing the hash
        // then would abort it.
        const idleLimit = pages > 0 ? JUMP_IDLE_MS : JUMP_FIRST_IDLE_MS
        // Cold start, nothing has EVER changed: a dropped seek. Kick the host
        // once instead of burning the whole first-idle budget on dead air.
        if (!kicked && onKick && baseline === "0" && now - lastChange > KICK_AFTER_MS) {
          kicked = true
          lastChange = now
          skipNextPage = true
          onKick()
          return
        }
        if (now - lastChange > idleLimit) finish(null)
      }
      const existing = findRow(messageID)
      if (existing) return finish(existing)
      observer = new MutationObserver(() => check(false))
      observer.observe(document.documentElement, { childList: true, subtree: true })
      poll = setInterval(() => check(true), 120)
      timer = setTimeout(() => finish(findRow(messageID)), Math.max(400, timeout))
    })

  const cancelJump = () => {
    jumpToken++
    setJumping(false)
    setJumpPages(0)
    setJumpElapsed(0)
    setJumpChain(0)
    setJumpEta(null)
    setJumpProgress(null)
    setBusyID("")
    flash("已取消跳转")
  }

  // ---- ETA estimator -------------------------------------------------------
  // Used ONLY for user-initiated jumps, where the host really does move the
  // viewport through the history: every change of the mounted-row fingerprint
  // is one host page landing, and from that cadence the remaining time to the
  // target index can be projected. Rough by nature (the host exposes no store
  // progress), but it converges: after 2-3 pages the rates are measured.
  //
  // IMPORTANT: "remaining" is the DISTANCE between the target index and the
  // oldest mounted index, never a signed difference. The old code compared
  // them as `target - mounted`; for a target older than what is mounted that
  // went negative, clamped to 0, and the header proudly reported
  // "100% · 还需 <1s" while the host was still paging.
  const eta = {
    // Turn id the estimate points at + its 0-based index in the full list.
    targetID: "",
    targetIndex: 0,
    total: 0,
    startedAt: 0,
    lastChange: 0,
    pages: 0,
    pageMs: PAGE_MS_DEFAULT,
    turnsPerPage: TURNS_PER_PAGE_DEFAULT,
    // Distance at the start of this estimate: the denominator of the progress
    // bar. It never grows, so the bar can never go backwards.
    startRemaining: 1,
    // Oldest mounted index seen at the last update, to measure turns/page.
    lastMounted: -1,
    // Set when the prewarm already pulled the whole history into the host's
    // store. The seek then only has to SCROLL - no page cadence applies, so
    // projecting from turns/page would announce a huge ETA for an instant jump.
    warm: false,

    // Index of the oldest turn currently mounted in the timeline, or -1.
    mountedOldest() {
      const list = untrack(turns)
      for (let i = 0; i < list.length; i++) if (findRow(list[i].id)) return i
      return -1
    },
    // Turns that still separate the mounted range from the target. A target
    // newer than the mounted range needs no paging at all (the host already
    // holds newer messages and merely scrolls), so it is 0.
    remaining(mountedOldest) {
      if (mountedOldest < 0) return null
      if (this.targetIndex >= mountedOldest) return 0
      return mountedOldest - this.targetIndex
    },
    reset(targetID, targetIndex, total) {
      this.targetID = targetID
      this.targetIndex = targetIndex
      this.total = total
      this.warm = false
      this.startedAt = Date.now()
      this.lastChange = this.startedAt
      this.pages = 0
      this.lastMounted = this.mountedOldest()
      // The host tears its timeline down for a moment when the router starts
      // seeking, so the mounted range is often unknown exactly at jump start.
      // `mountedOldest()` returning -1 used to make `remaining()` null, which
      // blanked the ETA for the whole jump (only the elapsed clock showed).
      // Assume a screenful above the newest turn instead: correct whenever the
      // user was at the bottom, and always gives an immediate estimate.
      if (this.lastMounted < 0) {
        this.lastMounted = Math.max(0, this.total - TURNS_PER_PAGE_DEFAULT)
      }
      const start = this.remaining(this.lastMounted)
      this.startRemaining = Math.max(1, start ?? 1)
    },
    // Called on every fingerprint change (= one page landed).
    page(now) {
      this.pages++
      // A page landing proves the store was NOT complete: drop the warm hint
      // so the measured cadence takes over from here.
      this.warm = false
      if (this.lastChange && now - this.lastChange > 200) {
        // Exponential moving average: recent pages weigh more; the host's
        // 2s cooldown makes the first sample dominate early, later samples
        // smooth jitter.
        const sample = now - this.lastChange
        this.pageMs = this.pages === 1 ? sample : Math.round(this.pageMs * 0.7 + sample * 0.3)
      }
      this.lastChange = now
    },
    // Recompute remaining turns from what is actually mounted now.
    update() {
      if (!this.targetID) return null
      // While the host is navigating it may unmount every row for a moment.
      // Fall back to the last known range (or a screenful from the newest
      // turn) instead of returning null, which used to blank the ETA.
      let mounted = this.mountedOldest()
      if (mounted < 0) mounted = this.lastMounted
      if (mounted < 0) mounted = Math.max(0, this.total - TURNS_PER_PAGE_DEFAULT)
      const remaining = this.remaining(mounted)
      if (remaining == null) return null
      // A page landing moves the mounted range: measure turns per page live so
      // the projection stops relying on the default.
      if (mounted >= 0 && this.lastMounted >= 0 && mounted < this.lastMounted) {
        const sample = this.lastMounted - mounted
        // A sample of 1 is almost always a virtual-list artifact, not a host
        // page. Letting it through collapsed turnsPerPage to 1 and made the
        // ETA explode ("还需 ~120s" for a few seconds of paging).
        if (sample >= 2) {
          this.turnsPerPage =
            this.pages <= 1 ? sample : Math.round(this.turnsPerPage * 0.6 + sample * 0.4)
        }
        this.lastMounted = mounted
      }
      this.startRemaining = Math.max(this.startRemaining, remaining)
      // 100% is only honest once the row is actually on screen.
      if (findRow(this.targetID)) {
        setJumpProgress(1)
        setJumpEta(0)
        return 0
      }
      if (this.warm) {
        // The prewarm already loaded the whole history into the host's store:
        // this seek is a plain scroll, so report a short ETA instead of the
        // "还需 ~60s" that a turns/page projection would announce.
        setJumpProgress(0.9)
        setJumpEta(1)
        return 1
      }
      setJumpProgress(Math.min(0.97, Math.max(0, 1 - remaining / this.startRemaining)))
      const perPage = Math.max(3, Math.min(40, this.turnsPerPage))
      const pagesLeft = Math.max(1, Math.ceil(remaining / perPage))
      // `sincePage` keeps growing while the host is stalled. Subtracting it
      // from the whole projection drove the ETA to `max(1, negative)` = "还需
      // ~1s" forever (the "0% · 还需 ~1s · 31s" header). Count the overshoot
      // FORWARD instead: a stalled host now makes the estimate grow.
      const sincePage = Date.now() - this.lastChange
      const overrun = Math.max(0, sincePage - this.pageMs)
      const etaSec = Math.round((pagesLeft * this.pageMs + overrun) / 1000)
      setJumpEta(Math.max(1, etaSec))
      return etaSec
    },
  }

  // Starts (or retargets) the estimator for a jump.
  //
  // `warm` says the prewarm already loaded the whole history into the host's
  // store, so the seek is a scroll, not paging: the ETA must not be projected
  // from the paging cadence (that produced a huge number for an instant jump).
  //
  // The target must be a real index in the FULL turn list. If it is not (e.g.
  // the list walk has not finished yet), clear the estimate instead of leaving
  // the PREVIOUS target's numbers on screen - that stale state is how a
  // 7-turn session ended up showing "100% · 还需 <1s" forever.
  const etaStart = (targetID, warm) => {
    const list = untrack(turns)
    const index = list.findIndex((t) => t.id === targetID)
    if (index < 0) {
      eta.targetID = ""
      etaStop()
      return
    }
    eta.reset(targetID, index, list.length)
    eta.warm = !!warm
    eta.update()
  }

  const etaPage = () => {
    eta.page(Date.now())
    eta.update()
  }

  const etaStop = () => {
    // Also drop the target: a stray update (e.g. from the 500ms jump timer)
    // must not resurrect an estimate for a finished/cancelled jump.
    eta.targetID = ""
    setJumpEta(null)
    setJumpProgress(null)
  }

  const jump = async (turn) => {
    // Clicking the same turn again while its jump is running must NOT restart
    // the loop: every restart cancels the host's in-flight page load, which is
    // what makes a deep jump advance only one page per click. The header
    // already shows the progress, so just leave it running.
    if (jumping() && busyID() === turn.id) return
    // The host will be seeking/scrolling for a while: keep the prewarm out.
    // (After a successful jump the user is reading history anyway, which
    // already blocks prewarming; this only covers the alignment window.)
    jumpQuietUntil = Date.now() + 5000

    const path = routePath(ctx)
    const sc = scroller()
    const mounted = findRow(turn.id)

    // Fast path: the row is already mounted (e.g. the prewarm reached it), so
    // the jump is instant. If a prewarm is still running, re-target the host's
    // pending oldest-seek to this turn first - otherwise the host would scroll
    // to the oldest message when that seek completes and yank the viewport.
    if (mounted && sc) {
      if (warming()) {
        cancelWarm()
        if (path) navTo(path, turn.id)
      }
      alignAfterLand(mounted)
      pulse(mounted)
      return
    }

    const now = Date.now()
    // Same target clicked again shortly after: treat as idempotent re-scroll
    // instead of restarting the paging loop.
    if (turn.id === lastJumpTurnID && now - lastJumpAt < SAME_TARGET_WINDOW_MS) {
      const row = findRow(turn.id)
      if (row && sc) {
        alignAfterLand(row)
        pulse(row)
        return
      }
    }
    lastJumpAt = now
    lastJumpTurnID = turn.id
    lastJumpID = turn.id

    if (!path) {
      flash(`无法读取当前路由，无法定位 · ${diagnostics(ctx)}`)
      return
    }

    const token = ++jumpToken
    const sessionAtJump = sessionID()
    setJumping(true)
    setBusyID(turn.id)
    setJumpPages(0)
    setJumpElapsed(0)
    setJumpChain(0)
    // Pin the panel open even if the pointer has left it meanwhile.
    setOpen(true)
    const startedAt = Date.now()
    const elapsedTimer = setInterval(() => {
      setJumpElapsed(Math.round((Date.now() - startedAt) / 1000))
      // Keep the ETA counting down even while no page lands (see update()).
      eta.update()
    }, 500)
    // Pages loaded so far, accumulated across chains (a new chain restarts
    // the per-chain counter, the headline must not go backwards).
    let chainBase = 0
    try {
      // A prewarm may be paging history in. Take the viewport over from it
      // immediately instead of waiting: the user asked for a specific message,
      // and a prewarm can hold the viewport for up to 30s. Its guard stops the
      // moment the token moves (cancelWarm), so the two never fight - and any
      // history it already paged in stays in the host's store, so the seek
      // below is faster than it would have been.
      if (warming()) {
        cancelWarm()
        if (token !== jumpToken || sessionID() !== sessionAtJump) return
        // The host may still have the prewarm's OLDEST-seek pending; the plugin
        // cannot cancel it directly. Clearing the hash is the only thing that
        // resets the host's seek machine. This also guarantees that the seek
        // issued below is a fresh value even when the prewarm was already
        // seeking the same turn - the duplicate-hash case that left jumps
        // waiting at "0% · 还需 ~1s" for 30s.
        navClear(path)
        await sleep(JUMP_TOGGLE_DWELL_MS)
        if (token !== jumpToken || sessionID() !== sessionAtJump) return
      }

      // Deep history, no prewarm. The host's own seek machine does the heavy
      // lifting: hash.changed -> applying -> pending(target) -> target.synced
      // -> seek, loading the missing history asynchronously. Every extra hash
      // change RESETS that pending state and aborts the fetch in flight, which
      // is why hammering the hash made a deep jump advance one page per click.
      // So: set the hash once, then be patient; only bounce it through a
      // mounted turn when the host has been idle for JUMP_IDLE_MS.
      const deadline = Date.now() + JUMP_TOTAL_MS
      for (let chain = 0; chain < JUMP_ROUNDS && Date.now() < deadline; chain++) {
        // Abandon the loop if the user switched sessions mid-jump: toggling the
        // old route hash would navigate back to the previous session.
        if (token !== jumpToken || sessionID() !== sessionAtJump) return
        setJumpChain(chain + 1)

        if (lastNavID === turn.id) {
          // The hash already points at the target and the host ignores a
          // repeated value, so clear it first to force a fresh seek. This is
          // the fallback path, not the normal one.
          navClear(path)
          // Let the host commit the cleared route before seeking.
          await sleep(JUMP_TOGGLE_DWELL_MS)
        }
        if (token !== jumpToken || sessionID() !== sessionAtJump) return
        // Sample the mounted range BEFORE issuing the seek: the host unmounts
        // rows as soon as it starts navigating, and the initial estimate needs
        // the pre-jump position to know how deep the target is.
        if (chain === 0) etaStart(turn.id, warmedFor === sessionAtJump)
        navTo(path, turn.id)

        let chainPages = 0
        const remaining = Math.min(JUMP_CHAIN_MS, deadline - Date.now())
        const landed = await waitForRow(
          turn.id,
          token,
          remaining,
          (pages) => {
            chainPages = pages
            // Progress is shown in the panel header, not in a toast.
            setJumpPages(chainBase + pages)
            // One fingerprint change == one page landed: feed the ETA.
            etaPage()
          },
          // Cold start: the host dropped our seek (its machine activates only
          // after the timeline is ready). Bounce the hash through a mounted
          // turn to re-engage it now instead of waiting out the idle budget.
          () => {
            const other = oldestLoadedTurn() ?? turns()[0]
            if (other && other.id !== turn.id) {
              navTo(path, other.id)
            }
          },
        )
        chainBase += chainPages
        if (token !== jumpToken || sessionID() !== sessionAtJump) return
        if (landed) {
          alignAfterLand(landed)
          pulse(landed)
          return
        }
        // The host went idle without landing: it exhausted this chain. The
        // next iteration bounces the hash to start a new one.
      }

      if (token === jumpToken) flash(`未能定位 · ${diagnostics(ctx)}`)
    } finally {
      clearInterval(elapsedTimer)
      etaStop()
      // A newer jump owns the signals when the token moved on.
      if (token === jumpToken) {
        setJumping(false)
        setJumpPages(0)
        setJumpElapsed(0)
        setJumpChain(0)
        setBusyID("")
      }
    }
  }

  // ---- prewarm ------------------------------------------------------------
  // The host loads history one page at a time with a hard 2s cooldown between
  // pages (its own paging machine: AS=2e3), which is why a deep jump waits
  // several seconds. The plugin can pay that cost in advance: ask the host to
  // seek to the OLDEST turn - its seek machine then pages all the way back -
  // and restore the viewport afterwards. Once the store holds the whole
  // history every jump is instant.
  const [warming, setWarming] = createSignal(false)

  // ---- viewport intent ----------------------------------------------------
  // Prewarm works by asking the host to seek the OLDEST message, so the host
  // necessarily scrolls the timeline. Two rules keep that invisible:
  //
  //   1. the viewport is put back before the browser paints (scroll listener +
  //      animation frame), so the seek is never rendered;
  //   2. the moment a human touches the viewport the prewarm yields - fighting
  //      a real scroll is what produced the "jitter / can't scroll up" bug.
  // A held pointer blocks prewarm, but a drag that ends outside the window
  // never fires pointerup here: expire it so prewarm cannot stall forever.
  const pointerBusy = () => pointerHeld && Date.now() - pointerHeldAt < 15000

  const userBusy = () =>
    pointerBusy() || Date.now() < userActiveUntil || Date.now() - lastEventAt < EVENT_QUIET_MS

  // Records human intent on the viewport and, if a prewarm is mid-flight, makes
  // it yield immediately (it resumes on its own once the human goes idle).
  const noteUserIntent = () => {
    userActiveUntil = Date.now() + USER_IDLE_MS
    if (untrack(warming)) yieldWarm()
  }

  onMount(() => {
    const inRail = (event) => {
      const path = event.composedPath?.() ?? []
      return path.some((node) => node instanceof Element && node.closest?.(".sr-rail"))
    }
    const onWheel = (event) => {
      if (inRail(event)) return
      noteUserIntent()
    }
    const onPointerDown = (event) => {
      if (inRail(event)) return
      // Holding the button means a drag (scrollbar, text selection): prewarm
      // must not fight it for as long as it lasts.
      pointerHeld = true
      pointerHeldAt = Date.now()
      noteUserIntent()
    }
    const onPointerUp = () => {
      if (!pointerHeld) return
      pointerHeld = false
      userActiveUntil = Math.max(userActiveUntil, Date.now() + 400)
    }
    const onTouch = (event) => {
      if (inRail(event)) return
      noteUserIntent()
    }
    const onKey = (event) => {
      if (
        event.key === "PageUp" ||
        event.key === "PageDown" ||
        event.key === "Home" ||
        event.key === "End" ||
        event.key === "ArrowUp" ||
        event.key === "ArrowDown" ||
        event.key === " "
      ) {
        noteUserIntent()
      }
    }
    // Passive + capture: we never preventDefault, we only observe.
    document.addEventListener("wheel", onWheel, { capture: true, passive: true })
    document.addEventListener("touchstart", onTouch, { capture: true, passive: true })
    document.addEventListener("pointerdown", onPointerDown, true)
    document.addEventListener("pointerup", onPointerUp, true)
    document.addEventListener("pointercancel", onPointerUp, true)
    window.addEventListener("keydown", onKey, true)
    onCleanup(() => {
      document.removeEventListener("wheel", onWheel, true)
      document.removeEventListener("touchstart", onTouch, true)
      document.removeEventListener("pointerdown", onPointerDown, true)
      document.removeEventListener("pointerup", onPointerUp, true)
      document.removeEventListener("pointercancel", onPointerUp, true)
      window.removeEventListener("keydown", onKey, true)
    })
  })

  const snapshotView = () => {
    const sc = scroller()
    if (!sc) return undefined
    const fromBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight
    return { fromBottom, atBottom: fromBottom <= 24 }
  }

  // User is reading history (not parked at the bottom of the timeline).
  const readingHistory = () => {
    const snap = snapshotView()
    return !!snap && !snap.atBottom
  }

  // Builds the "hold the viewport still" guard used while the host is paging.
  //
  // Why bottom-only: prewarming asks the host to seek the OLDEST message, so
  // the host always scrolls away from where the user is. Restoring an arbitrary
  // mid-history position needs an anchor row, and the virtual list recycles
  // rows while older history is prepended - the old fallback then recomputed a
  // position near the bottom on every tick, which is exactly the "jitter, stuck
  // at the bottom, cannot scroll up" report.
  //
  // Pinning to the BOTTOM instead is stable and needs no anchor: the bottom is
  // a well-defined coordinate even while content grows, and a user who is
  // already at the bottom sees nothing move. Users reading mid-history are
  // never prewarmed at all (see prewarm), so their viewport is never touched.
  //
  // The guard runs from the scroll listener (synchronously, before paint) and
  // from rAF, so the host's seek is never actually rendered.
  const makeGuard = (targetID) => {
    const state = { stopped: false, landed: false, seeked: false, top: scroller()?.scrollTop ?? 0 }
    const apply = () => {
      if (state.stopped) return
      const sc = scroller()
      if (!sc) return
      // Probe BEFORE restoring: restoring the viewport unmounts the row the
      // host just seeked to, so this is the only moment the mount is visible.
      if (targetID && !state.landed && findRow(targetID)) state.landed = true
      // A host seek toward OLDER history decreases scrollTop; our own
      // correction increases it. Direction tells them apart. This matters for
      // short sessions: nothing has to be paged in, the host simply scrolls,
      // and the target row may never survive a frame because the guard pins it
      // back - so "the host moved toward the target" is the only success
      // signal available there.
      const top = sc.scrollTop
      if (top < state.top - 24) state.seeked = true
      state.top = top
      if (sc.scrollHeight - sc.scrollTop - sc.clientHeight > 1) sc.scrollTop = sc.scrollHeight
      state.top = sc.scrollTop
    }
    const stop = () => {
      state.stopped = true
    }
    return { apply, stop, landed: () => state.landed, seeked: () => state.seeked }
  }

  const cancelWarm = () => {
    warmToken++
    setWarming(false)
    if (!jumping()) etaStop()
  }

  // A human is driving the viewport: give up this attempt but keep the session
  // eligible for a later one (unlike warmBlockedFor, which means "never").
  const yieldWarm = () => {
    if (!untrack(warming)) return
    cancelWarm()
    scheduleWarmRetry(1500)
  }

  const scheduleWarmRetry = (delay) => {
    if (warmRetryTimer) return
    const sid = sessionID()
    if (!sid || warmedFor === sid || warmBlockedFor === sid) return
    if (jumping()) return
    if (Date.now() > warmRetryUntil) return
    warmRetryTimer = setTimeout(() => {
      warmRetryTimer = undefined
      maybePrewarm()
    }, delay)
  }

  // "The host already holds every turn" - the only condition under which a
  // prewarm seek is pointless. Deliberately NOT `findRow(oldest)`: the
  // timeline is virtualized, so the oldest row can be missing from the DOM
  // even though nothing needs paging in. Using findRow() there made every
  // short session look cold, and the resulting seek is what made the plugin
  // and the host fight over the scroll position.
  const historyComplete = () => {
    const list = untrack(turns)
    if (list.length === 0) return false
    // Only meaningful once the whole turn list is known: with a partially
    // walked list, index 0 is not the oldest turn of the session.
    if (listCompleteFor !== untrack(sessionID)) return false
    for (let i = 0; i < list.length; i++) if (findRow(list[i].id)) return i === 0
    return false
  }
  // Prewarm once per session, right after the turn list loads (or on hover /
  // /turns). Every session that actually needs paging gets it: the warm cost
  // for a short session is one cheap host page, and it guarantees the first
  // click lands instantly.
  //
  // It only starts when the timeline is actually mounted (the host drops seeks
  // issued before its seek machine is ready - that used to cost the first
  // click 12s of dead air) and when nobody is using the viewport.
  const maybePrewarm = () => {
    const sid = sessionID()
    if (!sid || warming()) return
    // A jump owns the hash and the viewport: starting a prewarm now would
    // cancel the host's in-flight seek (that is what made deep jumps advance
    // one page per click). The resume effect below can fire right after a jump
    // cancelled the prewarm, so this guard is load-bearing.
    if (jumping()) return
    // Same window, one level weaker: a jump that already finished still leaves
    // the host scrolling/aligning for a moment. Reschedule instead of dropping
    // the prewarm, otherwise a single click could end warming for the session.
    if (Date.now() < jumpQuietUntil) {
      scheduleWarmRetry(Math.max(600, jumpQuietUntil - Date.now() + 200))
      return
    }
    if (warmedFor === sid || warmBlockedFor === sid) return
    if (turns().length < 1 && !oldestProbe) return
    if (historyComplete()) {
      warmedFor = sid
      return
    }
    const sc = scroller()
    if (!sc || !sc.querySelector("[data-message-id]")) {
      // Timeline not mounted yet: try again shortly instead of burning a seek.
      scheduleWarmRetry(800)
      return
    }
    if (userBusy()) {
      scheduleWarmRetry(WARM_RETRY_DELAY_MS)
      return
    }
    // Never prewarm while the user is reading history: the seek would move
    // their viewport. Retry later in case they scroll back to the bottom.
    if (readingHistory()) {
      scheduleWarmRetry(3000)
      return
    }
    void prewarm()
  }

  const prewarm = async () => {
    if (warming()) return
    const path = routePath(ctx)
    const sid = sessionID()
    if (!path || !sid) return
    // Target: the real oldest turn. `turns()[0]` is only trustworthy once the
    // list walk reached the end of the history; before that the head is just
    // the oldest of the pages fetched so far, and the asc probe is correct.
    let oldest = listCompleteFor === sid ? turns()[0] : undefined
    if (!oldest && oldestProbe) oldest = { id: oldestProbe, created: 0, text: "" }
    if (!oldest) oldest = turns()[0]
    if (!oldest) return
    if (warmedFor === sid) return
    // Prewarming necessarily scrolls the host to the oldest message, so it is
    // only allowed when the user is parked at the BOTTOM: pinning back to the
    // bottom is then a no-op for them. Anyone reading older messages is left
    // alone (see maybePrewarm, which never even starts in that case).
    const snap = snapshotView()
    if (!snap) {
      scheduleWarmRetry(800)
      return
    }
    if (!snap.atBottom) return
    // The host may still be paging: the deadline is the only budget needed now
    // that the guard pins the viewport and progress is measured by content
    // growth (which stops the attempt as soon as the host goes quiet).
    const deadlineMs = 30000
    const kickBudget = 4
    const token = ++warmToken
    setWarming(true)
    // No percentage during a prewarm: the viewport is pinned to the bottom, so
    // the mounted rows never advance and any "progress" we computed from them
    // was fiction - that is where the "预热中 · 100% · 还需 <1s" while still
    // paging came from. The header shows an indeterminate bar instead. A
    // determinate ETA is only shown for user-initiated jumps, where the host
    // really does move the viewport through the history.
    eta.targetID = ""
    etaStop()
    // Hold the viewport still while the host pages. rAF is not enough on its
    // own: the host may scroll and paint between frames, so a scroll listener
    // runs the same guard synchronously. Both are cheap (a rect read + one
    // write, and only when something actually moved).
    const guard = makeGuard(oldest.id)
    const sc = scroller()
    // Gate the scroll listener on the token: a user scroll cancels the prewarm
    // synchronously, but this listener may still fire before the loop's finally
    // runs - pinning then would fight the user exactly once.
    const onScroll = () => {
      if (token === warmToken) guard.apply()
    }
    sc?.addEventListener("scroll", onScroll, { passive: true })
    let raf = 0
    const guardStep = () => {
      if (token !== warmToken) return
      guard.apply()
      raf = requestAnimationFrame(guardStep)
    }
    raf = requestAnimationFrame(guardStep)
    try {
      navTo(path, oldest.id)
      // The host's seek machine starts inactive and DROPS a seek issued before
      // the timeline is ready - exactly the situation on session open. So don't
      // wait blindly for the oldest row: watch for real paging progress, and if
      // the host goes silent, bounce the hash to re-engage it once it is ready.
      // If it never engages, bail fast (without marking warm) so clicks fall
      // back to a direct jump instead of all showing "预热中 · 稍等一下" for 2min.
      const deadline = Date.now() + deadlineMs
      // Progress signal for a prewarm CANNOT be the mounted-row fingerprint:
      // the guard pins the viewport to the bottom, so the visible rows stay
      // identical even while the host pages. Prepending older history grows the
      // scroll height, which is the honest signal here.
      const contentHeight = () => scroller()?.scrollHeight ?? 0
      let lastHeight = contentHeight()
      let lastChange = Date.now()
      let kicks = 0
      let progressed = false
      while (Date.now() < deadline && token === warmToken) {
        // The guard probes for the target before restoring: restoring the
        // viewport unmounts that row, so this is the only reliable moment.
        if (guard.landed()) break
        await sleep(250)
        if (token !== warmToken) break
        if (guard.landed()) break
        // The human took the viewport back: stop driving it.
        if (userBusy()) {
          yieldWarm()
          return
        }
        const now = Date.now()
        const height = contentHeight()
        if (height > lastHeight) {
          // Older history was prepended: the host is paging. Keep waiting and
          // reset the kick budget.
          lastHeight = height
          lastChange = now
          kicks = 0
          progressed = true
        } else if (now - lastChange > 3000) {
          // The host has gone quiet. If it paged at all, the history it needed
          // is in its store - stop now instead of holding the viewport for the
          // rest of the deadline. Only a host that never paged needs a kick.
          if (progressed) break
          if (kicks >= kickBudget) break // host never engaged: give up, stay un-warm
          // Re-engage: a repeated identical hash is ignored by the router, so
          // clear it first, then seek to the oldest again.
          navClear(path)
          await sleep(JUMP_TOGGLE_DWELL_MS)
          if (token !== warmToken) break
          navTo(path, oldest.id)
          lastChange = Date.now()
          kicks++
        }
      }
      if (token !== warmToken) return
      // The host pages *toward* the seek target, which here is the oldest turn:
      // once it has paged at all and then gone quiet, the history it needed is
      // in its store. On a short session nothing is paged at all - the host
      // just scrolls - so a seek toward the top counts too. Without that,
      // short sessions could never prove themselves warm and kept retrying.
      const done = guard.landed() || progressed || guard.seeked()
      // Final correction: the host left the viewport at the seek target.
      guard.apply()
      if (done) {
        warmedFor = sid
        warmFailures = 0
      } else if (warmFailures >= 1) {
        // Second failure: stop trying automatically. A failed prewarm must not
        // permanently poison the session, but it must not loop either.
        warmBlockedFor = sid
      } else {
        // One retry later: the host may simply have been busy or the timeline
        // may still have been warming up. Retrying once costs nothing.
        warmFailures++
        scheduleWarmRetry(4000)
      }
      // Silent on success: prewarming is an implementation detail.
    } finally {
      cancelAnimationFrame(raf)
      guard.stop()
      sc?.removeEventListener("scroll", onScroll)
      if (token === warmToken) {
        setWarming(false)
        // Keep a jump's ETA alive if one is riding the prewarm; otherwise clear.
        if (!jumping()) etaStop()
      }
    }
  }

  // Session switch: abort any jump/prewarm in flight - they target the old
  // route, and toggling its hash would navigate back to the previous session.
  let guardSid = untrack(sessionID)
  createEffect(() => {
    const sid = sessionID()
    if (sid === guardSid) return
    guardSid = sid
    cancelWarm()
    jumpToken++
    setJumping(false)
    setJumpPages(0)
    setJumpElapsed(0)
    setJumpChain(0)
    setJumpEta(null)
    setJumpProgress(null)
    setBusyID("")
  })

  // Resume the prewarm after a jump interrupted it, so the remaining older
  // history still gets warmed for the next click. The initial start happens in
  // load()'s finally (once the full turn list is in); this only fires when the
  // warming signal flips back to false while the session is not fully warm.
  // A prewarm that gave up (warmBlockedFor) is NOT retried here, otherwise a
  // host that never engages would loop forever and keep every click on "稍等".
  createEffect(() => {
    const sid = sessionID()
    const count = turns().length
    const hot = warming()
    // `jumping()` is read on purpose: when a jump cancels the prewarm, this
    // effect re-runs with hot=false and would immediately restart the prewarm,
    // stealing the hash back from the jump in flight.
    const busy = jumping()
    if (!sid || count < 1 || hot || busy || warmedFor === sid || warmBlockedFor === sid) return
    if (loadingActive || loadedFor !== sid) return
    const timer = setTimeout(() => maybePrewarm(), 400)
    onCleanup(() => clearTimeout(timer))
  })

  // ---- search / keyboard navigation --------------------------------------
  // Filtered view of the turns; identity-stable so <For> keeps DOM nodes.
  const visibleTurns = createMemo(() => {
    const list = turns()
    const needle = query().trim().toLowerCase()
    if (!needle) return list
    return list.filter((turn) => turn.text.toLowerCase().includes(needle))
  })

  // The row the ↑/↓ keys currently point at (index within visibleTurns).
  const [cursorIndex, setCursorIndex] = createSignal(-1)
  const clearCursor = () => setCursorIndex(-1)

  const moveCursor = (delta) => {
    const list = visibleTurns()
    if (list.length === 0) return
    let index = cursorIndex()
    if (index < 0) {
      // Start from the active turn when the cursor is fresh, so ↓ walks to the
      // next turn relative to where the viewport already is.
      const activeID = active()
      index = list.findIndex((turn) => turn.id === activeID)
      if (index < 0) index = delta > 0 ? -1 : 0
    }
    index = Math.min(list.length - 1, Math.max(0, index + delta))
    setCursorIndex(index)
    requestAnimationFrame(() => {
      document
        .querySelector(`.sr-list .sr-turn[data-index="${index}"]`)
        ?.scrollIntoView({ block: "nearest" })
    })
  }

  const activateCursor = () => {
    const turn = visibleTurns()[cursorIndex()]
    if (!turn) return
    void jump(turn)
  }

  // The search input, for focus round-trips.
  let searchInput: HTMLInputElement | undefined
  const listKeyDown = (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      event.stopPropagation()
      moveCursor(1)
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      event.stopPropagation()
      moveCursor(-1)
    } else if (event.key === "Enter" && cursorIndex() >= 0) {
      event.preventDefault()
      event.stopPropagation()
      activateCursor()
    }
  }

  // Keep the highlighted row visible while a jump pages through history.
  createEffect(() => {
    if (!jumping()) return
    if (!busyID()) return
    requestAnimationFrame(() => {
      try {
        document
          .querySelector('.sr-list .sr-turn[data-busy="true"]')
          ?.scrollIntoView({ block: "nearest" })
      } catch {}
    })
  })

  const rail = (
    <>
      <Show when={status()}>
        <div class="sr-status">{status()}</div>
      </Show>
      <div
        class="sr-rail"
        data-open={open() ? "true" : "false"}
        data-jumping={jumping() ? "true" : "false"}
        data-pinned={pinned() ? "true" : "false"}
        role={open() ? "dialog" : undefined}
        aria-label={open() ? "会话轮次" : undefined}
        onMouseEnter={() => {
          setOpen(true)
          maybePrewarm()
        }}
        // Keep the panel pinned while a long history jump runs or when the
        // user pinned it; otherwise the mouse drifting off the rail hides
        // exactly the progress the user is waiting for. Esc / × still close
        // (or cancel) it.
        onMouseLeave={() => {
          if (!jumping() && !pinned()) setOpen(false)
        }}
      >
        <div class="sr-head">
          <Show
            when={jumping()}
            fallback={
              <span class="sr-title">
                会话轮次
                {turns().length > 0 ? ` · ${turns().length}` : ""}
                <Show when={query().trim()}> · 匹配 {visibleTurns().length}</Show>
              </span>
            }
          >
            <span class="sr-title sr-progress">
              {"加载历史中"}
              {jumpProgress() != null ? ` · ${Math.round(jumpProgress() * 100)}%` : ""}
              {jumpEta() != null ? ` · 还需 ~${jumpEta() > 0 ? jumpEta() : "<1"}s` : ""}
              {jumpPages() > 0 ? ` · ${jumpPages()} 页` : ""}
              {jumpElapsed() > 0 ? ` · ${jumpElapsed()}s` : ""}
            </span>
            {/* Thin determinate bar under the header; indeterminate shimmer
                while the ETA has no target position yet. */}
            <span class="sr-eta-bar" data-live={jumpProgress() != null ? "true" : "false"}>
              <span class="sr-eta-fill" style={{ width: jumpProgress() != null ? `${Math.round(jumpProgress() * 100)}%` : "" }} />
            </span>
          </Show>
          <span class="sr-head-actions">
            <button
              type="button"
              class="sr-iconbtn"
              data-on={pinned() ? "true" : "false"}
              title={pinned() ? "取消固定 (⌘⌥P)" : "固定面板 (⌘⌥P)"}
              aria-label={pinned() ? "取消固定面板" : "固定面板"}
              aria-pressed={pinned() ? "true" : "false"}
              onClick={() => setPinned(!pinned())}
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <Show
                  when={pinned()}
                  fallback={
                    <>
                      <path d="M9.5 2.5l4 4-2.6.9-1.4 3.5-4.4-4.4L8.6 5.1z" />
                      <path d="M5.1 6.5L2.5 9.1l4.4 4.4 2.6-2.6" />
                    </>
                  }
                >
                  <path d="M6 3l7 7-3.5.5L7 13 3 9l2.5-2.5z" />
                  <path d="M4 12l-1.5 1.5" />
                </Show>
              </svg>
            </button>
            <button
              type="button"
              class="sr-close"
              title={jumping() ? "取消跳转 (Esc)" : "关闭 (Esc)"}
              onClick={() => {
                if (jumping()) cancelJump()
                else setOpen(false)
              }}
            >
              ×
            </button>
          </span>
        </div>
        <Show when={turns().length >= 8}>
          <div class="sr-search">
            <input
              ref={searchInput}
              type="text"
              class="sr-search-input"
              placeholder="搜索轮次…"
              value={query()}
              onInput={(event) => {
                setQuery(event.currentTarget.value)
                clearCursor()
              }}
              onKeyDown={listKeyDown}
            />
            <Show when={query()}>
              <button
                type="button"
                class="sr-search-clear"
                aria-label="清除搜索"
                onClick={() => {
                  setQuery("")
                  clearCursor()
                  searchInput?.focus()
                }}
              >
                ×
              </button>
            </Show>
          </div>
        </Show>
        <div
          class="sr-list"
          onKeyDown={listKeyDown}
          tabIndex={-1}
        >
          <Show when={visibleTurns().length > 0} fallback={<div class="sr-note">{note() || `… ${VERSION}`}</div>}>
            <For each={visibleTurns()}>
              {(turn, index) => (
                <button
                  type="button"
                  class="sr-turn"
                  data-active={active() === turn.id ? "true" : "false"}
                  data-cursor={cursorIndex() === index() ? "true" : "false"}
                  data-busy={jumping() && busyID() === turn.id ? "true" : "false"}
                  data-index={index()}
                  onClick={() => void jump(turn)}
                >
                  <span class="sr-text">
                    <span class="sr-num">#{turns().indexOf(turn) + 1}</span>
                    <span class="sr-time">{formatTime(turn.created)}</span>
                    {turn.text}
                  </span>
                  <Show when={jumping() && busyID() === turn.id}>
                    <span class="sr-badge">加载中</span>
                  </Show>
                  <span class="sr-dash" />
                </button>
              )}
            </For>
          </Show>
        </div>
        {/* Messages that need attention (errors, cancel confirmations) live in
            the panel footer while it is open, and next to the collapsed rail
            when it is closed - the old bottom-right toast was easy to miss. */}
        <Show when={open() && status()}>
          <div class="sr-foot">{status()}</div>
        </Show>
      </div>
      <Show when={!open() && status()}>
        <div class="sr-status">{status()}</div>
      </Show>
    </>
  )

  // Portal to <body>: window.bottom is a bottom strip with its own stacking
  // context, which can clip or re-anchor position:fixed children.
  return <Portal mount={document.body}>{rail}</Portal>
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

export default Plugin.define({
  i18n: {
    en: {
      "command.jump": "Session turns: show / jump",
      "command.jump.description": "Reveal the turn rail; click a turn to jump to that message",
      "command.pin": "Session turns: pin panel",
      "command.pin.description": "Toggle pinning the turn rail open (⌘⌥P)",
    },
  },
  setup(ctx) {
    ctx.add(Style, CSS)

    // NOTE: never clear an existing #message-<id> hash here. The desktop app
    // uses it as a deep link and its cursor machine owns that state.

    ctx.add(Slot, {
      at: "window.bottom",
      render: () => (
        <Show when={ctx.sessions.current()}>
          <Rail session={() => ctx.sessions.current()} />
        </Show>
      ),
    })

    ctx.add(Command, () => ({
      id: "jump",
      title: ctx.t("command.jump"),
      description: ctx.t("command.jump.description"),
      section: "navigation",
      bind: "mod+alt+r",
      slash: { name: "turns" },
      run: () => {
        window.dispatchEvent(new Event(OPEN_EVENT))
      },
    }))

    ctx.add(Command, () => ({
      id: "pin",
      title: ctx.t("command.pin"),
      description: ctx.t("command.pin.description"),
      section: "navigation",
      bind: "mod+alt+p",
      slash: { name: "turns-pin" },
      run: () => {
        window.dispatchEvent(new Event(PIN_EVENT))
      },
    }))
  },
})
