import { Command, Plugin, Slot, Style, usePlugin } from "@opencode/plugin/gui"
import { For, Show, createEffect, createSignal, onCleanup, onMount, untrack } from "solid-js"
import { Portal } from "solid-js/web"

// ---------------------------------------------------------------------------
// constants / helpers
// ---------------------------------------------------------------------------

const VERSION = "v11"
const HASH_PREFIX = "message-"
const DIAG_EVENT = "session-turns:diag"
const OPEN_EVENT = "session-turns:open"

// paging: a full load walks every page; a light refresh pulls just the newest
// page (new messages always land at the head of a desc listing).
const FULL_PAGE_LIMIT = 40
const FULL_PAGE_SIZE = 200
const LIGHT_PAGE_SIZE = 50

// jump loop budgets
const JUMP_ROUNDS = 30
const JUMP_TOTAL_MS = 15000
const JUMP_ROW_TIMEOUT_MS = 6000
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
  // Native scrolling reaches the real scroll ancestor without depending on
  // the viewport selector; then compensate for the sticky session title.
  row.scrollIntoView({ block: "start" })
  const title = scroller.querySelector("[data-session-title]")
  const inset = title instanceof HTMLElement ? title.offsetHeight : 0
  if (inset) scroller.scrollTop -= inset + 12
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
  right: 10px;
  max-height: 60vh;
  width: 14px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  justify-content: center;
  gap: 2px;
  padding: 8px 4px;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: none;
  /* keep wheel scrolling from chaining into the host timeline when the rail
     reaches its own end */
  overscroll-behavior: contain;
  z-index: 400;
  border-radius: 10px;
  color: var(--text-base, currentColor);
  background: transparent;
  transition: width .18s ease, background .18s ease, box-shadow .18s ease;
}
.sr-rail::-webkit-scrollbar { display: none; }
.sr-rail[data-open="true"] {
  width: 360px;
  padding: 10px 8px;
  justify-content: flex-start;
  background: var(--surface-base, rgba(125,125,125,.16));
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  box-shadow: 0 6px 28px rgba(0,0,0,.22);
}
.sr-head {
  display: none;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 2px 6px;
  margin-bottom: 4px;
  border-bottom: 1px solid rgba(127,127,127,.22);
  flex-shrink: 0;
  width: 100%;
}
.sr-rail[data-open="true"] .sr-head { display: flex; }
.sr-title { font-size: 11px; opacity: .55; white-space: nowrap; }
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
.sr-turn:focus-visible, .sr-close:focus-visible { outline: 1px solid currentColor; outline-offset: -1px; }
.sr-dash {
  display: block;
  width: 10px;
  height: 2px;
  border-radius: 1px;
  background: currentColor;
  opacity: .28;
  flex-shrink: 0;
  transition: opacity .12s ease, width .12s ease;
}
.sr-turn:hover .sr-dash,
.sr-turn[data-active="true"] .sr-dash { opacity: .95; width: 18px; }
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
.sr-rail[data-open="true"] .sr-text { display: block; }
.sr-num { opacity: .75; margin-right: 5px; font-variant-numeric: tabular-nums; }
.sr-turn:hover .sr-text {
  opacity: 1;
  background: var(--surface-base-hover, rgba(127,127,127,.14));
}
.sr-turn[data-active="true"] .sr-text {
  opacity: 1;
  font-weight: 600;
  background: var(--surface-base-hover, rgba(127,127,127,.14));
}
/* brief highlight of the row a jump landed on */
.sr-flash-target { animation: srPulse 1.5s ease-out 1; }
@keyframes srPulse {
  0%, 30% { background: rgba(255,170,60,.4); }
  100% { background: transparent; }
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

  // Brief highlight on the row a jump landed on. The row may be unmounted by
  // the virtual list right after; the timer then just no-ops.
  const pulse = (row) => {
    try {
      row.classList.remove("sr-flash-target")
      void row.offsetWidth // restart the animation when re-pulsing the same row
      row.classList.add("sr-flash-target")
      setTimeout(() => row.classList.remove("sr-flash-target"), 1600)
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

  // Resolves when the row enters the DOM (MutationObserver, with a cheap poll
  // as a belt-and-braces fallback), or null on timeout / supersession.
  const waitForRow = (messageID, token, timeout) =>
    new Promise((resolve) => {
      let done = false
      let observer
      let poll
      let timer
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
      const check = () => {
        if (token !== jumpToken) return finish(null)
        const row = findRow(messageID)
        if (row) finish(row)
      }
      const existing = findRow(messageID)
      if (existing) return finish(existing)
      observer = new MutationObserver(check)
      observer.observe(document.documentElement, { childList: true, subtree: true })
      poll = setInterval(check, 120)
      timer = setTimeout(() => finish(findRow(messageID)), Math.max(400, timeout))
    })

  const jump = async (turn) => {
    const token = ++jumpToken
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

    // The host only pages in ~one history page (~5 turns) per seek and then goes
    // idle. Drive it: each round toggles the hash to an already-loaded turn and
    // back to the target, so the cursor machine runs another seek/page.
    // A newer click bumps jumpToken, which cancels this loop at every await.
    const deadline = Date.now() + JUMP_TOTAL_MS
    for (let round = 0; round < JUMP_ROUNDS && Date.now() < deadline; round++) {
      if (token !== jumpToken) return
      flash(round === 0 ? "定位中…" : `加载历史… ${round}`)

      if (lastNavID === turn.id) {
        const other = oldestLoadedTurn() ?? turns()[0]
        if (other) {
          navTo(path, other.id)
          await sleep(120)
        }
      }
      if (token !== jumpToken) return
      navTo(path, turn.id)

      const remaining = Math.min(JUMP_ROW_TIMEOUT_MS, deadline - Date.now())
      const landed = await waitForRow(turn.id, token, remaining)
      if (token !== jumpToken) return
      if (landed) {
        const live = scroller() ?? sc
        if (live) scrollToRow(live, landed)
        pulse(landed)
        flash("已定位")
        return
      }
    }

    if (token === jumpToken) flash(`未能定位 · ${diagnostics(ctx)}`)
  }

  const rail = (
    <>
      <Show when={status()}>
        <div class="sr-status">{status()}</div>
      </Show>
      <div
        class="sr-rail"
        data-open={open() ? "true" : "false"}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        <div class="sr-head">
          <span class="sr-title">会话轮次{turns().length > 0 ? ` · ${turns().length}` : ""}</span>
          <button type="button" class="sr-close" title="关闭 (Esc)" onClick={() => setOpen(false)}>
            ×
          </button>
        </div>
        <Show when={turns().length > 0} fallback={<div class="sr-note">{note() || `… ${VERSION}`}</div>}>
          <For each={turns()}>
            {(turn, index) => (
              <button
                type="button"
                class="sr-turn"
                data-active={active() === turn.id ? "true" : "false"}
                onClick={() => void jump(turn)}
              >
                <span class="sr-text">
                  <span class="sr-num">#{index() + 1}</span>
                  {formatTime(turn.created)} {turn.text}
                </span>
                <span class="sr-dash" />
              </button>
            )}
          </For>
        </Show>
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
