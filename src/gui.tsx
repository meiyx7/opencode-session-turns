import { Command, Plugin, Slot, Style, usePlugin } from "@opencode/plugin/gui"
import { For, Show, createEffect, createSignal, onCleanup, onMount, untrack } from "solid-js"
import { Portal } from "solid-js/web"

// ---------------------------------------------------------------------------
// constants / helpers
// ---------------------------------------------------------------------------

const VERSION = "v13"
const HASH_PREFIX = "message-"
const DIAG_EVENT = "session-turns:diag"
const OPEN_EVENT = "session-turns:open"

// paging: a full load walks every page; a light refresh pulls just the newest
// page (new messages always land at the head of a desc listing).
const FULL_PAGE_LIMIT = 40
const FULL_PAGE_SIZE = 200
const LIGHT_PAGE_SIZE = 50

// jump loop budgets. One round pages in roughly one host history page (~5
// turns); a round ends once the host's row set has stopped changing, so a
// half-finished page is never interrupted by the next hash toggle.
const JUMP_ROUNDS = 120
const JUMP_TOTAL_MS = 45000
const JUMP_ROW_TIMEOUT_MS = 3000
const JUMP_SETTLE_MS = 300
const JUMP_TOGGLE_DWELL_MS = 220
const SAME_TARGET_WINDOW_MS = 800

// Filled by Rail.load()/jump() so the command palette can report diagnostics.
let lastTurnCount = 0
let lastNote = ""
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
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
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
const findRow = (messageID) =>
  document.getElementById(`${HASH_PREFIX}${messageID}`) ??
  [...document.querySelectorAll("[data-message-id]")].find(
    (node) => node.getAttribute("data-message-id") === messageID,
  )

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
  return `轮次 ${lastTurnCount} · 容器 ${scroller ? "OK" : "缺失"} · DOM ${nodes.length} 行${target}${id} · 路由 ${route} · hash ${window.location.hash || "(空)"}${lastNote ? ` · ${lastNote}` : ""}`
}

const scrollToRow = (scroller, row) => {
  // Align by rects instead of scrollIntoView: the host puts the row top flush
  // against the sticky session title, but a 16px gradient fade sits right below
  // it and would cover the top of the bubble (and our outline). Leave 24px so
  // the bubble clears both the title and the fade.
  const title = scroller.querySelector("[data-session-title]")
  const scRect = scroller.getBoundingClientRect()
  const titleBottom =
    title instanceof HTMLElement ? title.getBoundingClientRect().bottom : scRect.top
  const rowTop = row.getBoundingClientRect().top
  const delta = rowTop - (titleBottom + 24)
  if (Math.abs(delta) > 2) scroller.scrollTop += delta
}

// The host's own hash seek may finish after ours and re-align the row flush
// under the sticky title (its 16px fade then covers the bubble's top edge).
// Repair only that case: if the user already scrolled elsewhere, leave it be.
const repairScroll = (row) => {
  setTimeout(() => {
    if (!row.isConnected) return
    const sc = findScroller()
    if (!sc) return
    const title = sc.querySelector("[data-session-title]")
    const titleBottom =
      title instanceof HTMLElement ? title.getBoundingClientRect().bottom : sc.getBoundingClientRect().top
    const rowTop = row.getBoundingClientRect().top
    if (rowTop < titleBottom + 4) sc.scrollTop += rowTop - (titleBottom + 24)
  }, 300)
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
/* the scrollable list; the header stays fixed above it */
.sr-list {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: none;
}
.sr-rail[data-open="true"] .sr-list { justify-content: flex-start; gap: 1px; scrollbar-width: thin; }
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
/* pulse a landed bubble: outline follows the bubble's own border-radius, so no
   shape is imposed and the message background stays untouched */
.sr-flash-ring { animation: srRing 1.8s ease-out 1; }
@keyframes srRing {
  0% {
    outline: 2px solid rgba(255,170,60,.95);
    outline-offset: 2px;
    box-shadow: 0 0 24px rgba(255,170,60,.45);
  }
  60% {
    outline: 2px solid rgba(255,170,60,.35);
    outline-offset: 2px;
    box-shadow: 0 0 12px rgba(255,170,60,.15);
  }
  100% {
    outline: 2px solid rgba(255,170,60,0);
    outline-offset: 2px;
    box-shadow: 0 0 0 rgba(255,170,60,0);
  }
}
.sr-note {
  display: none;
  font-size: 11px;
  opacity: .4;
  padding: 2px;
}
.sr-rail[data-open="true"] .sr-note { display: block; }
.sr-status {
  position: fixed;
  right: 30px;
  bottom: 150px;
  z-index: 401;
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 6px;
  background: var(--background-strong, rgba(0,0,0,.75));
  color: var(--text-base, #fff);
  opacity: .9;
  pointer-events: none;
  white-space: pre-wrap;
  max-width: min(720px, 90vw);
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
  // Jump progress. While `jumping` is true the panel stays pinned open and the
  // header reports the page being loaded; `busyID` marks the target row.
  const [jumping, setJumping] = createSignal(false)
  const [jumpPage, setJumpPage] = createSignal(0)
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

  const load = async (id, mode) => {
    const token = ++loadToken
    loadingActive = true
    let error = ""
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
        if (!next || fresh === 0) break
        cursor = next
      }
    } finally {
      loadingActive = false
      loadedFor = id
      lastNote = error
      setNote(cache.size === 0 ? error || "暂无用户消息" : "")
      // A message arrived while a full load was running: catch up now.
      if (pendingBump) {
        pendingBump = false
        scheduleLight()
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
  // real scroller without querying first) plus one rAF-throttled pass, with a
  // slow interval as a fallback for rows mounting without a scroll (history
  // paging, virtual list swaps).
  let scrollerCache
  const scroller = () => {
    if (scrollerCache?.isConnected) return scrollerCache
    scrollerCache = findScroller()
    return scrollerCache
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
        if (id) setActive(id)
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
    })
  }

  onMount(() => {
    const onScroll = () => scheduleTrack()
    document.addEventListener("scroll", onScroll, true)
    const fallback = setInterval(scheduleTrack, 1500)
    onCleanup(() => {
      document.removeEventListener("scroll", onScroll, true)
      clearInterval(fallback)
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
        setOpen(false)
        // Only swallow Esc while the rail is actually open, so the host keeps
        // its own Escape handling the rest of the time.
        event.stopPropagation()
      }
    }
    const onPointerDown = (event) => {
      if (!untrack(open)) return
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
    // /turns toggles the panel; Esc / outside click / × also close it. No more
    // forced auto-close after 4s.
    const onOpen = () => setOpen((value) => !value)
    window.addEventListener(DIAG_EVENT, onDiag)
    window.addEventListener(OPEN_EVENT, onOpen)
    onCleanup(() => {
      window.removeEventListener(DIAG_EVENT, onDiag)
      window.removeEventListener(OPEN_EVENT, onOpen)
    })
    // One-shot confirmation that this window actually runs the rebuilt bundle.
    flash(`会话轮次 ${VERSION} 已加载`)
  })

  // ---- jump ----------------------------------------------------------------
  // The memory router's hash is invisible to us (window.location is stale), so
  // track the last id we navigated to in order to force a hash change each round.
  let lastNavID = ""
  let jumpToken = 0
  let lastJumpAt = 0
  let lastJumpTurnID = ""

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

  // Resolves when the row enters the DOM (MutationObserver, with a cheap poll
  // as a belt-and-braces fallback), or null on timeout / supersession / when
  // the host has paged in another slice (the caller then drives the next seek).
  const waitForRow = (messageID, token, timeout) =>
    new Promise((resolve) => {
      let done = false
      let observer
      let poll
      let timer
      const started = Date.now()
      const baseline = rowSignature()
      let lastSig = baseline
      let stableSince = started
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
          stableSince = now
          return
        }
        // Only treat the page as done once the host has stopped appending rows
        // for a moment: toggling the hash mid-load cancels its paging and the
        // jump stalls until the user clicks again.
        if (now - started > JUMP_SETTLE_MS && lastSig !== baseline && now - stableSince > 350) {
          finish(null)
        }
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
    setJumpPage(0)
    setBusyID("")
    flash("已取消跳转")
  }

  const jump = async (turn) => {
    // Clicking the same turn again while its jump is running must NOT restart
    // the loop: every restart cancels the host's in-flight page load, which is
    // what makes a deep jump advance only one page per click. Re-affirm the
    // progress instead and let the running loop finish.
    if (jumping() && busyID() === turn.id) {
      flash(`正在跳转 · 第 ${jumpPage()} 页`, JUMP_TOTAL_MS)
      return
    }

    const token = ++jumpToken
    // A new click always owns the progress UI. This also clears a previous
    // jump's state when the new target takes the mounted fast path, where the
    // superseded loop's finally no longer touches these signals.
    setJumping(false)
    setJumpPage(0)
    setBusyID("")
    lastJumpID = turn.id
    const now = Date.now()

    // Same target clicked again shortly after: treat as idempotent re-scroll
    // instead of restarting the paging loop.
    if (turn.id === lastJumpTurnID && now - lastJumpAt < SAME_TARGET_WINDOW_MS) {
      const row = findRow(turn.id)
      const sc = scroller()
      if (row && sc) {
        scrollToRow(sc, row)
        pulse(row)
        return
      }
    }
    lastJumpAt = now
    lastJumpTurnID = turn.id

    const sc = scroller()
    const row = findRow(turn.id)

    // Fast path: the row is mounted, scroll locally.
    if (row && sc) {
      scrollToRow(sc, row)
      pulse(row)
      flash("已定位")
      return
    }

    const path = routePath(ctx)
    if (!path) {
      flash(`无法读取当前路由，无法定位 · ${diagnostics(ctx)}`)
      return
    }

    // Deep history: the host only pages in ~one history page (~5 turns) per
    // seek and then goes idle. Drive it: each round toggles the hash to an
    // already-loaded turn and back to the target, so the cursor machine runs
    // another seek/page. A round ends as soon as rows appear instead of always
    // sleeping 6s. A newer click bumps jumpToken, which cancels this loop at
    // every await; Esc cancels it too.
    const sessionAtJump = sessionID()
    setJumping(true)
    setBusyID(turn.id)
    setJumpPage(0)
    // Pin the panel open even if the pointer has left it meanwhile.
    setOpen(true)
    flash("正在定位…", JUMP_TOTAL_MS)
    try {
      const deadline = Date.now() + JUMP_TOTAL_MS
      for (let round = 0; round < JUMP_ROUNDS && Date.now() < deadline; round++) {
        // Abandon the loop if the user switched sessions mid-jump: toggling the
        // old route hash would navigate back to the previous session.
        if (token !== jumpToken || sessionID() !== sessionAtJump) return
        setJumpPage(round + 1)
        flash(`跳转中 · 第 ${round + 1} 页`, JUMP_TOTAL_MS)

        if (lastNavID === turn.id) {
          const other = oldestLoadedTurn() ?? turns()[0]
          if (other) {
            navTo(path, other.id)
            // Let the host commit the intermediate hash before seeking back;
            // too fast and both clicks collapse into the same target hash, so
            // the cursor machine never runs another page.
            await sleep(JUMP_TOGGLE_DWELL_MS)
          }
        }
        if (token !== jumpToken || sessionID() !== sessionAtJump) return
        navTo(path, turn.id)

        const remaining = Math.min(JUMP_ROW_TIMEOUT_MS, deadline - Date.now())
        const landed = await waitForRow(turn.id, token, remaining)
        if (token !== jumpToken || sessionID() !== sessionAtJump) return
        if (landed) {
          const live = scroller() ?? sc
          if (live) scrollToRow(live, landed)
          pulse(landed)
          flash("已定位")
          repairScroll(landed)
          return
        }
      }

      if (token === jumpToken) flash(`未能定位 · ${diagnostics(ctx)}`)
    } finally {
      // A newer jump owns the signals when the token moved on.
      if (token === jumpToken) {
        setJumping(false)
        setJumpPage(0)
        setBusyID("")
      }
    }
  }

  // Keep the busy row visible in the panel list while the jump pages through
  // history, so the "which turn am I waiting for" answer stays on screen.
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
        onMouseEnter={() => setOpen(true)}
        // Keep the panel pinned while a long history jump runs; otherwise the
        // mouse drifting off the rail hides exactly the progress the user is
        // waiting for. Esc / × still close (or cancel) it.
        onMouseLeave={() => {
          if (!jumping()) setOpen(false)
        }}
      >
        <div class="sr-head">
          <Show
            when={jumping()}
            fallback={
              <span class="sr-title">会话轮次{turns().length > 0 ? ` · ${turns().length}` : ""}</span>
            }
          >
            <span class="sr-title sr-progress">
              跳转中{jumpPage() > 0 ? ` · 第 ${jumpPage()} 页` : ""}
            </span>
          </Show>
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
        </div>
        <div class="sr-list">
          <Show when={turns().length > 0} fallback={<div class="sr-note">{note() || `… ${VERSION}`}</div>}>
            <For each={turns()}>
              {(turn, index) => (
                <button
                  type="button"
                  class="sr-turn"
                  data-active={active() === turn.id ? "true" : "false"}
                  data-busy={jumping() && busyID() === turn.id ? "true" : "false"}
                  onClick={() => void jump(turn)}
                >
                  <span class="sr-text">
                    <span class="sr-num">#{index() + 1}</span>
                    <span class="sr-time">{formatTime(turn.created)}</span>
                    {turn.text}
                  </span>
                  <span class="sr-dash" />
                </button>
              )}
            </For>
          </Show>
        </div>
      </div>
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
      group: ctx.t("command.jump"),
      section: "navigation",
      bind: "mod+alt+r",
      slash: { name: "turns" },
      run: () => {
        window.dispatchEvent(new Event(OPEN_EVENT))
      },
    }))
  },
})
