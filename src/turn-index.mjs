export const firstLine = (message) => {
  // Only the first non-empty line is needed; avoid allocating a string array
  // for a multi-megabyte prompt just to display its preview.
  const match = String(message?.text ?? "").match(/\S[^\r\n]*/)
  if (match) return match[0].trim()
  const files = message?.files?.length ?? 0
  return files > 0 ? `[附件 ×${files}]` : "(空消息)"
}

export const putTurn = (cache, message) => {
  const turn = { id: message.id, created: message.time?.created ?? 0, text: firstLine(message) }
  const prev = cache.get(turn.id)
  if (prev && prev.created === turn.created && prev.text === turn.text) return false
  cache.set(turn.id, turn)
  return true
}

// Fetch only new pages on revisits, but keep walking if >50 turns arrived
// while away. Never silently truncate a long session at 40 pages.
export async function readTurnPages(client, sessionID, { signal, knownIDs = new Set(), incremental = false, onPage }) {
  let cursor
  const cursors = new Set()
  const seenIDs = new Set()
  for (;;) {
    if (signal.aborted) throw signal.reason
    const params = { sessionID, type: "user", limit: incremental ? 50 : 200 }
    if (cursor) params.cursor = cursor
    else params.order = "desc"
    const response = await client.message.list(params, { signal })
    if (signal.aborted) throw signal.reason
    const messages = response?.data ?? []
    const overlap = messages.some((message) => knownIDs.has(message.id))
    for (const message of messages) seenIDs.add(message.id)
    onPage(messages)
    const next = response?.cursor?.next
    if (!next) return { complete: true, seenIDs }
    if (incremental && overlap) return { complete: false, seenIDs }
    if (cursors.has(next)) throw new Error("轮次接口返回重复游标，已停止重复请求")
    cursors.add(next)
    cursor = next
  }
}

// A small window-local LRU: revisiting a session can display its index without
// refetching every page. Bound both session count and total retained turns.
export function createIndexCache(maxSessions = 8, maxTurns = 16000) {
  const entries = new Map()
  return {
    get(key) {
      const value = entries.get(key)
      if (value) {
        entries.delete(key)
        entries.set(key, value)
      }
      return value
    },
    set(key, value) {
      entries.delete(key)
      entries.set(key, value)
      let size = [...entries.values()].reduce((sum, item) => sum + item.turns.length, 0)
      while (entries.size > maxSessions || size > maxTurns) {
        const oldest = entries.keys().next().value
        size -= entries.get(oldest).turns.length
        entries.delete(oldest)
      }
    },
  }
}
