// Observe actual target mounting, not every change of the virtual row range.
// Virtual scrolling changes that range without loading a single history page.
export function waitForTarget({ getRow, root, signal, timeoutMs = 5000, Observer = MutationObserver }) {
  return new Promise((resolve) => {
    let observer, poll, timer
    let done = false
    const finish = (row = null) => {
      if (done) return
      done = true
      observer?.disconnect()
      clearInterval(poll)
      clearTimeout(timer)
      signal.removeEventListener("abort", cancel)
      resolve(row)
    }
    const cancel = () => finish()
    if (signal.aborted) return finish()
    const existing = getRow()
    if (existing) return finish(existing)
    const check = () => {
      const row = getRow()
      if (row) finish(row)
    }
    observer = new Observer(check)
    observer.observe(root, { childList: true, subtree: true })
    poll = setInterval(check, 250)
    timer = setTimeout(() => finish(getRow()), timeoutMs)
    signal.addEventListener("abort", cancel, { once: true })
  })
}
