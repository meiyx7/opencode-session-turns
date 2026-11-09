import { Command, Plugin, Slot, Style, usePlugin } from "@opencode/plugin/gui"
import { For, Show, createEffect, createSignal, onCleanup, onMount, untrack } from "solid-js"
import { Portal } from "solid-js/web"

// ---------------------------------------------------------------------------
// constants / helpers
// ---------------------------------------------------------------------------

const VERSION = "v10"
const HASH_PREFIX = "message-"
const DIAG_EVENT = "session-turns:diag"
const OPEN_EVENT = "session-turns:open"

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
  z-index: 400;
  border-radius: 10px;
  color: var(--text-base, currentColor);
  background: transparent;
  transition: width .18s ease;
}
.sr-rail::-webkit-scrollbar { display: none; }
.sr-rail[data-open="true"] { width: 360px; background: transparent; }
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
.sr-turn:hover .sr-text {
  opacity: 1;
  background: var(--surface-base-hover, rgba(127,127,127,.14));
}
.sr-turn[data-active="true"] .sr-text {
  opacity: 1;
  font-weight: 600;
  background: var(--surface-base-hover, rgba(127,127,127,.14));
}
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
.sr-note { font-size: 11px; opacity: .4; padding: 2px; }
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

  let loading = false
  let loadedFor = ""
  let closeTimer
  // The memory router's hash is invisible to us (window.location is stale), so
  // track the last id we navigated to in order to force a hash change each round.
  let lastNavID = ""

  const load = async (sessionID) => {
    if (!sessionID || loading) return
    loading = true
    const collected = new Map()
    let cursor
    let error = ""
    try {
      for (let page = 0; page < 40; page++) {
        // The server rejects `cursor` together with `order`
        // (InvalidCursorError: "Cursor cannot be combined with order").
        // The cursor itself already encodes the original order/direction,
        // so only the first page declares order: "desc".
        const params = cursor
          ? { sessionID, type: "user", limit: 200, cursor }
          : { sessionID, type: "user", limit: 200, order: "desc" }

        let response
        try {
          response = await ctx.client.message.list(params)
        } catch (cause) {
          error = String(cause?.message ?? cause)
          break
        }

        const data = response?.data ?? []
        let fresh = 0
        for (const message of data) {
          if (collected.has(message.id)) continue
          collected.set(message.id, {
            id: message.id,
            created: message.time?.created ?? 0,
            text: firstLine(message),
          })
          fresh++
        }
        const next = response?.cursor?.next
        if (!next || fresh === 0) break
        cursor = next
      }
    } finally {
      loading = false
    }

    // Publish whatever was collected even if a later page failed — a paging
    // error must never blank out the whole rail again.
    const list = [...collected.values()].sort((a, b) => a.created - b.created)
    setTurns(list)
    lastTurnCount = list.length
    lastNote = error
    setNote(list.length === 0 ? error || "暂无用户消息" : "")
    loadedFor = sessionID
  }

  const sessionID = () => props.session()?.id

  createEffect(() => {
    const id = sessionID()
    if (!id) return
    untrack(() => {
      if (loadedFor !== id) {
        setTurns([])
        setActive("")
        lastNavID = ""
        void load(id)
      }
    })
  })

  const poll = setInterval(() => {
    const id = sessionID()
    if (id) void load(id)
  }, 5000)
  onCleanup(() => clearInterval(poll))

  const trackActive = () => {
    const scroller = findScroller()
    if (!scroller) return
    const rows = [...scroller.querySelectorAll("[data-message-id]")]
    if (rows.length === 0) return
    const top = scroller.getBoundingClientRect().top + 40
    for (const row of rows) {
      if (row.getBoundingClientRect().bottom >= top) {
        const id = row.getAttribute("data-message-id")
        if (id) setActive(id)
        break
      }
    }
  }
  const track = setInterval(trackActive, 400)
  onCleanup(() => clearInterval(track))

  const flash = (text) => {
    setStatus(text)
    setTimeout(() => setStatus((current) => (current === text ? "" : current)), 3000)
  }

  onMount(() => {
    const onDiag = () => flash(`${VERSION} · ${diagnostics(ctx)}`)
    const onOpen = () => {
      setOpen(true)
      clearTimeout(closeTimer)
      closeTimer = setTimeout(() => setOpen(false), 4000)
    }
    window.addEventListener(DIAG_EVENT, onDiag)
    window.addEventListener(OPEN_EVENT, onOpen)
    onCleanup(() => {
      window.removeEventListener(DIAG_EVENT, onDiag)
      window.removeEventListener(OPEN_EVENT, onOpen)
      clearTimeout(closeTimer)
    })
    // One-shot confirmation that this window actually runs the rebuilt bundle.
    flash(`会话轮次 ${VERSION} 已加载`)
  })

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

  const jump = async (turn) => {
    lastJumpID = turn.id
    const scroller = findScroller()
    const row = findRow(turn.id)

    // Fast path: the row is mounted, scroll locally.
    if (row && scroller) {
      scrollToRow(scroller, row)
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
    for (let round = 0; round < 30; round++) {
      flash(round === 0 ? "定位中…" : `加载历史… ${round}`)

      if (lastNavID === turn.id) {
        const other = oldestLoadedTurn() ?? turns()[0]
        if (other) {
          navTo(path, other.id)
          await sleep(120)
        }
      }
      navTo(path, turn.id)

      for (let k = 0; k < 6; k++) {
        await sleep(80)
        const landed = findRow(turn.id)
        if (!landed) continue
        const live = findScroller() ?? scroller
        if (live) scrollToRow(live, landed)
        flash("已定位")
        return
      }
    }

    flash(`未能定位 · ${diagnostics(ctx)}`)
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
        <Show when={turns().length > 0} fallback={<div class="sr-note">{note() || `… ${VERSION}`}</div>}>
          <For each={turns()}>
            {(turn) => (
              <button
                type="button"
                class="sr-turn"
                data-active={active() === turn.id ? "true" : "false"}
                onClick={() => void jump(turn)}
              >
                <span class="sr-text">
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
        window.dispatchEvent(new Event(DIAG_EVENT))
      },
    }))
  },
})
