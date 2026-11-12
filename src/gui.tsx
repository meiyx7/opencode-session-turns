import { Command, Plugin, Slot, Style, usePlugin } from "@opencode/plugin/gui"
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js"
import { Portal } from "solid-js/web"
import { createHistoryLoader, historyAPI } from "./history.mjs"
import { createIndexCache, firstLine, putTurn, readTurnPages } from "./turn-index.mjs"
import { waitForTarget } from "./navigation.mjs"

// ---------------------------------------------------------------------------
// constants / helpers
// ---------------------------------------------------------------------------

const VERSION = "v27"
const HASH_PREFIX = "message-"
const DIAG_EVENT = "session-turns:diag"
const OPEN_EVENT = "session-turns:open"
const PIN_EVENT = "session-turns:pin"

// Lightweight turn previews survive a routing visit; heavy history belongs to
// the host's shared store, never a second plugin-owned transcript.
const indexCache = createIndexCache()

// Filled by Rail.load()/jump() so the command palette can report diagnostics.
let lastTurnCount = 0
let lastNote = ""
let lastAlign = ""
let lastJumpID = ""

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
const alignAfterLand = (row, current) => {
  const align = () => { if (current()) alignBubble(row) }
  align()
  setTimeout(align, 450)
  setTimeout(align, 1000)
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
/* Activity bar: the SDK publishes a whole history batch atomically, so no
   intermediate percentage/remaining-time estimate is available. */
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
  const [query, setQuery] = createSignal("")
  const [pinned, setPinned] = createSignal(false)
  const [jumping, setJumping] = createSignal(false)
  const [jumpElapsed, setJumpElapsed] = createSignal(0)
  const [jumpPhase, setJumpPhase] = createSignal("加载历史中")
  const [busyID, setBusyID] = createSignal("")
  const cache = new Map()
  const history = createHistoryLoader()
  const sessionID = () => props.session()?.id
  const sessionKey = () => props.session()?.key ?? `${props.session()?.server?.id ?? ""}\n${sessionID() ?? ""}`
  const client = () => props.session()?.server?.client ?? ctx.client
  let loadedKey = ""
  let listComplete = false
  let loadController
  let loadTask
  let warmTimer
  let disposed = false
  let lastNavID = ""
  let jumpToken = 0
  let jumpController

  const publish = () => {
    const list = [...cache.values()].sort((a, b) => a.created - b.created || a.id.localeCompare(b.id))
    const prev = untrack(turns)
    if (prev.length !== list.length || !prev.every((item, i) => item === list[i])) setTurns(list)
    lastTurnCount = list.length
    indexCache.set(loadedKey, { turns: list, complete: listComplete })
  }

  const load = (incremental = false) => {
    if (loadTask) return loadTask
    const sid = untrack(sessionID)
    const key = untrack(sessionKey)
    const api = client()
    if (!sid) return Promise.resolve()
    const controller = new AbortController()
    loadController = controller
    const knownIDs = new Set(cache.keys())
    const task = readTurnPages(api, sid, {
      signal: controller.signal,
      knownIDs,
      incremental,
      onPage(messages) {
        if (disposed || controller.signal.aborted || key !== untrack(sessionKey)) return
        for (const message of messages) putTurn(cache, message)
        publish()
      },
    }).then((result) => {
      if (disposed || controller.signal.aborted || key !== untrack(sessionKey)) return
      if (result.complete) {
        // Reconcile removals only after a successful full snapshot. Preserve
        // new turns delivered by the host while the request was in flight.
        if (!incremental) for (const id of knownIDs) if (!result.seenIDs.has(id)) cache.delete(id)
        listComplete = true
        publish()
      }
      setNote(cache.size ? "" : "暂无用户消息")
      lastNote = ""
      schedulePrewarm()
    }).catch((error) => {
      if (disposed || controller.signal.aborted || key !== untrack(sessionKey)) return
      lastNote = String(error?.message ?? error)
      setNote(cache.size ? "" : lastNote)
      if (cache.size) flash(`轮次更新失败：${lastNote}`)
    }).finally(() => {
      if (loadTask === task) loadTask = undefined
    })
    loadTask = task
    return task
  }

  // Background history loading uses the shared SDK store. It never sets a
  // router hash, never pins the viewport and never races a user jump. A click
  // joins this same request (or skips it if its target is already cached).
  const maybePrewarm = () => {
    if (disposed || document.hidden || untrack(jumping)) return
    const session = props.session()
    const api = historyAPI(session)
    const oldest = untrack(turns)[0]
    if (!api || !oldest || !listComplete) return
    if (session.server.data.session.status?.(session.id) === "running") return
    if (api.get(session.id, oldest.id)) return
    void history.ensure(session, oldest.id).catch((error) => {
      if (error?.name !== "AbortError") lastNote = String(error?.message ?? error)
    })
  }
  const schedulePrewarm = () => {
    clearTimeout(warmTimer)
    warmTimer = setTimeout(maybePrewarm, 600)
  }

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
  let observed = new WeakSet()
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

  // ---- navigation --------------------------------------------------------
  const pulse = (row) => {
    const bubble = row.querySelector('[data-slot="user-message-text"]') ?? row
    bubble.classList.remove("sr-flash-ring")
    void bubble.offsetWidth
    bubble.classList.add("sr-flash-ring")
    setTimeout(() => bubble.classList.remove("sr-flash-ring"), 1900)
  }
  const navTo = (path, id) => {
    clickRoute(`${path.split("#")[0]}#${HASH_PREFIX}${id}`)
    lastNavID = id
  }
  const navClear = (path) => {
    clickRoute(path.split("#")[0])
    lastNavID = ""
  }
  const cancelJump = () => {
    jumpToken++
    jumpController?.abort()
    history.cancel()
    if (untrack(jumping)) {
      const path = routePath(ctx)
      if (path) navClear(path)
    }
    setJumping(false)
    setBusyID("")
    setJumpElapsed(0)
    flash("已取消跳转")
  }

  const jump = async (turn) => {
    if (untrack(jumping) && untrack(busyID) === turn.id) return
    const path = routePath(ctx)
    if (!path) return flash("无法读取当前会话路由")
    // Invalidate BEFORE the mounted-row fast path as well. Otherwise the
    // previous async jump can land afterwards and steal the viewport back.
    const token = ++jumpToken
    jumpController?.abort()
    const controller = new AbortController()
    jumpController = controller
    const key = untrack(sessionKey)
    const current = () => !disposed && !controller.signal.aborted && token === jumpToken && key === untrack(sessionKey)
    lastJumpID = turn.id
    clearTimeout(warmTimer)
    setJumping(false)
    setBusyID("")
    setJumpElapsed(0)
    const mounted = findRow(turn.id)
    if (mounted && scroller()) {
      // Set the host's selected anchor too, so follow-to-bottom cannot undo
      // local alignment. Native prefetch has no pending seek to cancel.
      navTo(path, turn.id)
      alignAfterLand(mounted, current)
      pulse(mounted)
      return
    }
    setJumping(true)
    setBusyID(turn.id)
    setOpen(true)
    setJumpPhase("加载历史中")
    const startedAt = Date.now()
    const timer = setInterval(() => {
      if (current()) setJumpElapsed(Math.floor((Date.now() - startedAt) / 1000))
    }, 500)
    try {
      const session = props.session()
      const native = !!historyAPI(session)
      if (native) {
        // Store population first, navigation second: one host seek, with the
        // target already available. No hash-driven paging/retry machine.
        const found = await history.ensure(session, turn.id)
        if (!current()) return
        if (!found) {
          cache.delete(turn.id)
          publish()
          return flash("目标消息已删除或不可用，已更新轮次")
        }
        setJumpPhase("定位中")
      } else {
        // Older hosts can still use the memory-router path. Never touch
        // window.location: Desktop serves /index.html outside its real route.
        setJumpPhase("宿主分页定位中")
      }
      if (!current()) return
      if (lastNavID === turn.id) {
        navClear(path)
        await sleep(32)
        if (!current()) return
      }
      navTo(path, turn.id)
      let row = await waitForTarget({
        getRow: () => findRow(turn.id), root: document.body,
        signal: controller.signal, timeoutMs: native ? 2500 : 20000,
      })
      if (!current()) return
      // One bounded retry covers a timeline that mounted after the initial
      // router event. Loaded history is retained; it is never fetched again.
      if (!row) {
        navClear(path)
        await sleep(32)
        if (!current()) return
        navTo(path, turn.id)
        row = await waitForTarget({
          getRow: () => findRow(turn.id), root: document.body,
          signal: controller.signal, timeoutMs: native ? 2500 : 5000,
        })
      }
      if (!current()) return
      if (row) {
        alignAfterLand(row, current)
        pulse(row)
      } else {
        navClear(path)
        flash(native ? "历史已加载，界面暂未完成定位，请重试" : "宿主分页定位超时，请重试")
      }
    } catch (error) {
      if (current() && error?.name !== "AbortError") flash(String(error?.message ?? error))
    } finally {
      clearInterval(timer)
      if (current()) {
        setJumping(false)
        setBusyID("")
        setJumpElapsed(0)
      }
    }
  }

  // Routing and server reconnects cancel the OLD owners synchronously. All
  // finally blocks, observers, delayed alignment and elapsed timers are gated.
  createEffect(() => {
    const key = sessionKey()
    const api = client()
    untrack(() => {
      jumpToken++
      jumpController?.abort()
      history.cancel()
      loadController?.abort()
      loadTask = undefined
      clearTimeout(warmTimer)
      rowObserver?.disconnect()
      rowObserver = undefined
      observed = new WeakSet()
      scrollerCache = undefined
      loadedKey = key
      lastNavID = ""
      setJumping(false)
      setBusyID("")
      setJumpElapsed(0)
      setActive("")
      setStatus("")
      setQuery("")
      const saved = indexCache.get(key)
      cache.clear()
      for (const turn of saved?.turns ?? []) cache.set(turn.id, turn)
      listComplete = saved?.complete ?? false
      setTurns(saved?.turns ?? [])
      lastTurnCount = cache.size
      if (sessionID() && api) void load(listComplete)
    })
  })

  // Read the host's already-subscribed reactive store. Assistant text/tool
  // deltas are never inspected, and no second SSE iterator is left hanging.
  createEffect(() => {
    const session = props.session()
    const key = sessionKey()
    const api = historyAPI(session)
    const messages = api?.list(session.id) ?? []
    const users = messages.filter((message) => message.type === "user" || message.role === "user")
      .map((message) => ({ id: message.id, text: firstLine(message), time: { created: message.time?.created ?? 0 } }))
    untrack(() => {
      if (key !== loadedKey) return
      let changed = false
      for (const message of users) changed = putTurn(cache, message) || changed
      if (changed) publish()
    })
  })

  onCleanup(() => {
    disposed = true
    jumpToken++
    jumpController?.abort()
    loadController?.abort()
    history.cancel()
    clearTimeout(warmTimer)
  })

  // ---- search / keyboard navigation --------------------------------------
  // Filtered view of the turns; identity-stable so <For> keeps DOM nodes.
  const turnNumbers = createMemo(() => new Map(turns().map((turn, index) => [turn.id, index + 1])))

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
              {jumpPhase()}
              {jumpElapsed() > 0 ? ` · 已用 ${jumpElapsed()}s` : ""}
            </span>
            <span class="sr-eta-bar" data-live="false" aria-hidden="true">
              <span class="sr-eta-fill" />
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
                    <span class="sr-num">#{turnNumbers().get(turn.id)}</span>
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
