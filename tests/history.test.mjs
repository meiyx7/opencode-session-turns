import test from "node:test"
import assert from "node:assert/strict"
import { createHistoryLoader, historyAPI } from "../src/history.mjs"
import { waitForTarget } from "../src/navigation.mjs"
import { createIndexCache, firstLine, putTurn, readTurnPages } from "../src/turn-index.mjs"

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture(key = "local\nA") {
  const gate = deferred()
  const messages = new Map([["new", { id: "new" }]])
  const calls = []
  let more = true
  const api = {
    list: () => [...messages.values()], get: (_, id) => messages.get(id),
    more: () => more, sync: async () => { calls.push("sync") },
    async loadMore(id, options) {
      calls.push({ id, ...options })
      await gate.promise
      if (options.signal.aborted) return
      messages.set("old", { id: "old" })
      more = false
    },
  }
  return { session: { key, id: "A", server: { id: key.split("\n")[0], data: { session: { message: api } } } }, api, calls, gate }
}

test("cold prefetch and repeated/retargeted clicks join one bulk request", async () => {
  const f = fixture(), loader = createHistoryLoader()
  const warm = loader.ensure(f.session, "old")
  const click = loader.ensure(f.session, "old")
  const newer = await loader.ensure(f.session, "new")
  assert.equal(newer, true)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].all, true)
  assert.ok(f.calls[0].signal instanceof AbortSignal)
  f.gate.resolve()
  assert.deepEqual(await Promise.all([warm, click]), [true, true])
  assert.equal(await loader.ensure(f.session, "old"), true)
  assert.equal(f.calls.length, 1)
})

test("cancel releases waiters immediately even if SDK ignores AbortSignal", async () => {
  const f = fixture(), loader = createHistoryLoader()
  const task = loader.ensure(f.session, "old")
  loader.cancel()
  await assert.rejects(task, { name: "AbortError" })
  assert.equal(f.calls[0].signal.aborted, true)
  f.gate.resolve()
})

test("server + session key isolates the same session ID on different servers", async () => {
  const a = fixture(), b = fixture("remote\nA"), loader = createHistoryLoader()
  const old = loader.ensure(a.session, "old")
  const next = loader.ensure(b.session, "old")
  await assert.rejects(old, { name: "AbortError" })
  assert.equal(a.calls[0].signal.aborted, true)
  b.gate.resolve()
  assert.equal(await next, true)
  a.gate.resolve()
})

test("old finally cannot clear a newer session's in-flight request", async () => {
  const a = fixture(), b = fixture("remote\nA"), loader = createHistoryLoader()
  const old = loader.ensure(a.session, "old")
  loader.cancel()
  const next = loader.ensure(b.session, "old")
  await assert.rejects(old, { name: "AbortError" })
  const joined = loader.ensure(b.session, "old")
  assert.equal(b.calls.length, 1)
  b.gate.resolve()
  assert.deepEqual(await Promise.all([next, joined]), [true, true])
  a.gate.resolve()
})

test("timeout aborts batch and allows a later retry", async () => {
  const f = fixture(), loader = createHistoryLoader({ timeoutMs: 10 })
  await assert.rejects(loader.ensure(f.session, "old"), { name: "TimeoutError" })
  assert.equal(f.calls[0].signal.aborted, true)
  f.gate.resolve()
  assert.equal(await loader.ensure(f.session, "old"), true)
  assert.equal(f.calls.length, 2)
})

test("empty cold store joins initial sync before looking at the cursor", async () => {
  const f = fixture(), loader = createHistoryLoader()
  let ready = false
  f.api.list = () => ready ? [{ id: "new" }] : []
  f.api.sync = async () => { ready = true; f.calls.push("sync") }
  const task = loader.ensure(f.session, "old")
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.calls[0], "sync")
  f.gate.resolve()
  assert.equal(await task, true)
})

test("SDK errors do not poison retries; absent capability uses compatibility path", async () => {
  const f = fixture(), loader = createHistoryLoader()
  const task = loader.ensure(f.session, "old")
  f.gate.reject(new Error("offline"))
  await assert.rejects(task, /offline/)
  assert.equal(historyAPI({}), undefined)
  assert.equal(await loader.ensure({}, "old"), false)
})

test("incremental index fills gaps larger than one page and omits order with cursor", async () => {
  const calls = [], pages = [
    { data: [{ id: "3" }, { id: "2" }], cursor: { next: "page2" } },
    { data: [{ id: "1" }, { id: "known" }], cursor: { next: "page3" } },
  ]
  const result = await readTurnPages({ message: { list: async (params) => {
    calls.push(params); return pages.shift()
  } } }, "A", {
    signal: new AbortController().signal, incremental: true, knownIDs: new Set(["known"]), onPage() {},
  })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].order, "desc")
  assert.equal("order" in calls[1], false)
  assert.equal(result.complete, false)
  assert.equal(result.seenIDs.size, 4)
})

test("full index reaches beyond the old 40-page ceiling", async () => {
  let count = 0
  const result = await readTurnPages({ message: { list: async () => {
    const id = String(++count)
    return { data: [{ id }], cursor: { next: count < 45 ? id : undefined } }
  } } }, "A", { signal: new AbortController().signal, onPage() {} })
  assert.equal(count, 45)
  assert.equal(result.complete, true)
  assert.equal(result.seenIDs.size, 45)
})

test("repeated cursors stop instead of looping; aborted old pages never publish", async () => {
  let calls = 0
  await assert.rejects(readTurnPages({ message: { list: async () => {
    calls++; return { data: [], cursor: { next: "same" } }
  } } }, "A", { signal: new AbortController().signal, onPage() {} }), /重复游标/)
  assert.equal(calls, 2)
  const controller = new AbortController()
  let published = false
  await assert.rejects(readTurnPages({ message: { list: async () => {
    controller.abort(); return { data: [{ id: "stale" }] }
  } } }, "A", { signal: controller.signal, onPage() { published = true } }), { name: "AbortError" })
  assert.equal(published, false)
})

test("previews preserve identity and handle large empty/multiline prompts", () => {
  const map = new Map(), message = { id: "u", text: "\n   测试 \n正文", time: { created: 1 } }
  assert.equal(putTurn(map, message), true)
  const item = map.get("u")
  assert.equal(putTurn(map, message), false)
  assert.equal(map.get("u"), item)
  assert.equal(item.text, "测试")
  assert.equal(firstLine({ text: " ".repeat(1_000_000) }), "(空消息)")
  assert.equal(firstLine({ files: [1, 2] }), "[附件 ×2]")
})

test("LRU bounds both session count and retained turn count", () => {
  const cache = createIndexCache(2, 4)
  cache.set("A", { turns: [1, 2] }); cache.set("B", { turns: [3] })
  cache.get("A"); cache.set("C", { turns: [4, 5] })
  assert.equal(cache.get("B"), undefined)
  assert.ok(cache.get("A"))
  cache.set("huge", { turns: [1, 2, 3, 4, 5] })
  assert.equal(cache.get("huge"), undefined)
})

test("DOM wait cancels immediately and disconnects its observer", async () => {
  let connected = false
  class Observer {
    observe() { connected = true }
    disconnect() { connected = false }
  }
  const controller = new AbortController()
  const task = waitForTarget({ getRow: () => null, root: {}, signal: controller.signal, Observer })
  assert.equal(connected, true)
  controller.abort()
  assert.equal(await task, null)
  assert.equal(connected, false)
})
