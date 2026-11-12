import test from "node:test"
import assert from "node:assert/strict"
import { createRoot, createComputed } from "solid-js"
import { createData } from "@opencode/client/solid"
import { createHistoryLoader } from "../src/history.mjs"

// Exercise the actual SDK store used by Desktop, not a replacement loader.
function sdkFixture({ slowPage } = {}) {
  const all = Array.from({ length: 620 }, (_, i) => ({
    id: `msg_${String(i).padStart(5, "0")}`, type: "user", text: `turn ${i}`, time: { created: i },
  }))
  const calls = [], publications = []
  let dispose
  const data = createRoot((cleanup) => {
    dispose = cleanup
    const store = createData({
      directory: "/fixture", event: { on: () => () => {}, listen: () => () => {} },
      api: () => ({ message: { list: async (params) => {
        calls.push(params)
        if (params.cursor) {
          assert.equal("order" in params, false)
          await slowPage?.()
        }
        const offset = Number(params.cursor ?? 0)
        return {
          data: all.toReversed().slice(offset, offset + params.limit),
          cursor: { next: offset + params.limit < all.length ? String(offset + params.limit) : undefined },
        }
      } } }),
    })
    createComputed(() => publications.push(store.session.message.list("A").length))
    return store
  })
  return { all, calls, publications, dispose, data, session: { key: "local\nA", id: "A", server: { id: "local", data } } }
}

test("real SDK loads 600 missing messages in three 200-message reads and one publication", async () => {
  const f = sdkFixture()
  try {
    await f.data.session.message.sync("A")
    assert.equal(f.data.session.message.list("A").length, 20)
    const before = f.publications.length
    assert.equal(await createHistoryLoader().ensure(f.session, f.all[0].id), true)
    assert.deepEqual(f.calls.map((call) => call.limit), [20, 200, 200, 200])
    assert.equal(f.data.session.message.list("A").length, 620)
    assert.equal(f.publications.length - before, 1)
    assert.equal(f.data.session.message.more("A"), false)
  } finally { f.dispose() }
})

test("bulk loader joins a real host page already in flight", async () => {
  const f = sdkFixture({ slowPage: () => new Promise((resolve) => setTimeout(resolve, 2)) })
  try {
    await f.data.session.message.sync("A")
    const hostPage = f.data.session.message.loadMore("A")
    const found = createHistoryLoader().ensure(f.session, f.all[0].id)
    await hostPage
    assert.equal(await found, true)
    assert.deepEqual(f.calls.map((call) => call.limit), [20, 20, 200, 200, 200])
    assert.equal(new Set(f.calls.map((call) => call.cursor)).size, f.calls.length)
  } finally { f.dispose() }
})

test("cancelled real SDK batch never publishes stale history", async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const f = sdkFixture({ slowPage: () => gate })
  const loader = createHistoryLoader()
  try {
    await f.data.session.message.sync("A")
    const task = loader.ensure(f.session, f.all[0].id)
    loader.cancel()
    await assert.rejects(task, { name: "AbortError" })
    release()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(f.data.session.message.list("A").length, 20)
    assert.equal(f.data.session.message.loading("A"), false)
  } finally { release(); f.dispose() }
})
