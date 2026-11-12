import { createSignal, For } from "solid-js"
import { render } from "solid-js/web"
import plugin from "../src/gui.tsx"
import { Slot, Style } from "@opencode/plugin/gui"

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const check = (condition, message) => { if (!condition) throw new Error(message) }
const until = async (fn) => {
  for (let i = 0; i < 100; i++) { if (fn()) return; await delay(20) }
  throw new Error("Timed out waiting for fixture")
}
const stats = { indexCalls: [], bulkCalls: [], routes: [], scrollWrites: 0 }
const source = (name) => Array.from({ length: 1000 }, (_, i) => ({
  id: `${name}-${String(i + 1).padStart(4, "0")}`, type: "user",
  text: `${name} 第${String(i + 1).padStart(4, "0")}轮`, time: { created: i + 1 },
}))
function session(name) {
  const all = source(name)
  const [messages, setMessages] = createSignal(all.slice(-20))
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const native = {
    list: () => messages(), get: (_, id) => messages().find((message) => message.id === id),
    more: () => messages().length < all.length, sync: async () => {},
    async loadMore(id, options) {
      stats.bulkCalls.push({ id, options })
      await gate
      if (!options.signal.aborted) setMessages([...all])
    },
  }
  return {
    key: `local\n${name}`, id: name, release, all, messages, setMessages,
    server: { id: "local", data: { session: { message: native, status: () => "idle" } }, client: {
      message: { list: async (params) => {
        stats.indexCalls.push({ ...params })
        const offset = Number(params.cursor ?? 0)
        const data = all.toReversed().slice(offset, offset + params.limit)
        return { data, cursor: { next: offset + params.limit < all.length ? String(offset + params.limit) : undefined } }
      } },
    } },
  }
}
const a = session("A"), b = session("B")
const [current, setCurrent] = createSignal(a)
const [visible, setVisible] = createSignal(a.all.slice(-5))
const timeline = document.createElement("div")
timeline.dataset.slot = "session-timeline-scroll"
const scroller = document.createElement("div")
scroller.className = "scroll-view__viewport"
scroller.style.cssText = "height:400px;overflow-y:auto;width:600px"
timeline.appendChild(scroller)
document.body.appendChild(timeline)
const nativeScroll = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")
Object.defineProperty(scroller, "scrollTop", {
  get() { return nativeScroll.get.call(this) },
  set(value) { stats.scrollWrites++; nativeScroll.set.call(this, value) },
})
const disposeTimeline = render(() => <For each={visible()}>{(message) => (
  <div id={`message-${message.id}`} data-message-id={message.id} data-timeline-row="UserMessage" style={{ height: "100px" }}>
    <div data-slot="user-message-text">{message.text}</div>
  </div>
)}</For>, scroller)
let disposeRail
const ctx = {
  sessions: { current }, router: { path: () => `/server/local/session/${current().id}` },
  t: (key) => key,
  add(type, value) {
    if (type === Style) { const el = document.createElement("style"); el.textContent = value; document.head.appendChild(el) }
    if (type === Slot) disposeRail = render(() => value.render(), document.createElement("div"))
  },
}
globalThis.__ctx = ctx
const navigate = (event) => {
  const anchor = event.target.closest?.("a")
  if (!anchor) return
  event.preventDefault()
  const href = anchor.getAttribute("href")
  stats.routes.push(href)
  const id = href.split("#message-")[1]
  if (!id) return
  const item = current().server.data.session.message.get(current().id, id)
  if (item) setVisible([item])
}
document.addEventListener("click", navigate)
plugin.setup(ctx)
const turn = (name, index) => [...document.querySelectorAll(".sr-turn")].find((node) => node.textContent.includes(`${name} 第${String(index).padStart(4, "0")}轮`))
const results = []
try {
  await until(() => document.querySelectorAll(".sr-turn").length === 1000)
  check(stats.indexCalls.length === 5, "1000-turn index must use five 200-turn requests")
  window.dispatchEvent(new Event("session-turns:open"))
  await until(() => stats.bulkCalls.length === 1)
  check(stats.routes.length === 0 && stats.scrollWrites === 0, "background warm must not navigate or pin scrollTop")
  turn("A", 1).click(); turn("A", 1).click()
  check(stats.bulkCalls.length === 1, "warm + duplicate click must share one bulk request")
  turn("A", 1000).click()
  a.release()
  await delay(100)
  check(stats.routes.at(-1).endsWith("#message-A-1000"), "old cold jump stole viewport after mounted target click")
  check(document.querySelector(".sr-rail").dataset.jumping === "false", "old finally left jump busy")
  results.push("预热不移动视口；重复点击复用请求；新目标优先")

  turn("A", 1).click()
  await until(() => document.getElementById("message-A-0001"))
  await until(() => document.querySelector(".sr-rail").dataset.jumping === "false")
  check(stats.bulkCalls.length === 1, "cached jump reloaded history")
  check(!document.querySelector(".sr-head").textContent.includes("还需"), "unmeasurable ETA leaked")
  results.push("已加载历史直接定位；没有虚假的剩余时间")

  setCurrent(b); setVisible(b.all.slice(-5))
  await until(() => turn("B", 1))
  turn("B", 1).click()
  await until(() => stats.bulkCalls.length === 2)
  setCurrent(a); setVisible(a.all.slice(-5))
  check(stats.bulkCalls[1].options.signal.aborted, "session switch did not abort B history")
  const routesAtSwitch = stats.routes.length
  b.release()
  await delay(100)
  check(stats.routes.length === routesAtSwitch, "old B request navigated after switching to A")
  const aReads = stats.indexCalls.filter((call) => call.sessionID === "A")
  check(aReads.length === 6 && aReads.at(-1).limit === 50, "revisit must only refresh new index pages")
  results.push("切换会话立即取消旧任务；返回会话只增量查询")

  const readsBefore = stats.indexCalls.length
  const latest = { id: "A-1001", type: "user", text: "A 新提问", time: { created: 1001 } }
  a.all.push(latest); a.setMessages([...a.messages(), latest])
  await until(() => document.querySelectorAll(".sr-turn").length === 1001)
  check(stats.indexCalls.length === readsBefore, "live user turn should reuse host event store")
  const input = document.querySelector(".sr-search-input")
  input.value = "第0001轮"; input.dispatchEvent(new Event("input", { bubbles: true }))
  check(document.querySelectorAll(".sr-turn").length === 1, "search mismatch")
  check(document.querySelector(".sr-num").textContent === "#1", "search changed absolute turn number")
  results.push("新提问实时更新且无额外请求；搜索和轮次编号正常")
  document.getElementById("test-results").textContent = JSON.stringify({ ok: true, results, indexRequests: stats.indexCalls.length, bulkRequests: stats.bulkCalls.length })
} catch (error) {
  document.getElementById("test-results").textContent = JSON.stringify({ ok: false, error: String(error.stack ?? error), stats: { indexCalls: stats.indexCalls.length, bulkCalls: stats.bulkCalls.length, routes: stats.routes } })
} finally {
  disposeRail?.(); disposeTimeline()
  document.removeEventListener("click", navigate)
}
