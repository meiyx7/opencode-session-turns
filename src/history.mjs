// Use the SAME store as the timeline. Calling message.list() alone only fills
// the plugin's index; it does not make the host's virtual rows seekable.
export const historyAPI = (session) => {
  const api = session?.server?.data?.session?.message
  return ["list", "get", "more", "sync", "loadMore"].every((key) => typeof api?.[key] === "function")
    ? api
    : undefined
}

const aborted = () => new DOMException("已取消", "AbortError")

// Abort must release callers even when a server/older SDK ignores its signal.
const abortable = (request, signal) => new Promise((resolve, reject) => {
  const cancel = () => reject(signal.reason ?? aborted())
  if (signal.aborted) return cancel()
  signal.addEventListener("abort", cancel, { once: true })
  Promise.resolve(request).then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel))
})

export function createHistoryLoader({ timeoutMs = 20000 } = {}) {
  let active
  const cancel = () => {
    active?.controller.abort(aborted())
    active = undefined
  }
  return {
    cancel,
    async ensure(session, targetID) {
      const api = historyAPI(session)
      if (!api) return false
      if (api.get(session.id, targetID)) return true
      const key = session.key ?? `${session.server.id}\n${session.id}`
      if (active && (active.key !== key || active.api !== api)) cancel()
      if (!active) {
        const controller = new AbortController()
        const entry = { key, api, controller, promise: undefined }
        active = entry
        const timer = setTimeout(() => {
          controller.abort(new DOMException("历史加载超时，请重试", "TimeoutError"))
        }, timeoutMs)
        entry.promise = (async () => {
          // On a cold open the cursor is unknown until initial sync finishes.
          // sync() joins the host's initial read instead of starting a second one.
          if (api.list(session.id).length === 0) {
            await abortable(api.sync(session.id), controller.signal)
          }
          if (controller.signal.aborted) throw controller.signal.reason
          if (api.more(session.id)) {
            // SDK 2.2.6: 200 messages/request, no timeline's 2s cooldown, one
            // batched store publication. It also joins an in-flight host page.
            await abortable(api.loadMore(session.id, { all: true, signal: controller.signal }), controller.signal)
          }
        })().finally(() => {
          clearTimeout(timer)
          if (active === entry) active = undefined
        })
      }
      await active.promise
      return !!api.get(session.id, targetID)
    },
  }
}
