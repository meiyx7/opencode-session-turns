# opencode-session-turns

An **OpenCode Desktop** plugin that adds a slim rail on the right edge of the
conversation, listing **every user turn** of the current session. Hover the rail
to reveal the turns; click one to jump straight to that message.

> Works on OpenCode Desktop 2.2.6. The rail is a GUI plugin, loaded from the
> prebuilt `./gui-experimental` bundle.

```
┌─ Session turns (12) ────────┐
│ 09:14  #1  Fix this error…  │
│ 09:22  #2  What about async?│
│ 09:35  #3  Continue         │
│ ...                         │
└─────────────────────────────┘
```

## Features

- Lists every user turn of the current session (paged from the session API).
- Hover the right-edge rail to expand; move away to collapse.
- Click a turn to jump to its message — including turns far back in history.
- Highlights the turn currently in view.
- `/turns` slash command and `⌘⌥R` (`Ctrl+Alt+R`) to reveal the rail.

## Install

Add the package name to the `plugins` list in your `opencode.json`; OpenCode
installs it from npm on startup:

```json
{
  "plugins": ["opencode-session-turns"]
}
```

Restart OpenCode Desktop (the GUI bundle is loaded at window startup).

## Usage

- Move the mouse to the thin rail on the right edge of the conversation.
- Or press `⌘⌥R` / run `/turns` to reveal it.
- Click a turn to jump to that message.

## How it works (and why it is not trivial)

OpenCode Desktop 2.2.6 has some sharp edges that a GUI plugin has to respect:

- The timeline is **virtualized**: only rows near the viewport are mounted, so
  distant turns are not in the DOM.
- The desktop app uses a **memory history** for routing. `window.location`
  stays at `oc://renderer/index.html` and is decoupled from the real route.
  Writing `#message-<id>` to `window.location` (or firing `popstate`) makes the
  host parse `/index.html` as a route and throw a fatal `Unrecognised route!`.
- The GUI SDK exposes **no** `scrollToMessage()` / `navigate()` API
  (`ctx.router` is read-only).

So this plugin:

1. Picks the real route from `ctx.router.path()` (a valid
   `/server/…/session/…` path).
2. Fakes a click on an `<a href="<route>#message-<id>">`. The host's own
   document-level link interceptor turns that into a **memory-router navigate**,
   which drives the host's cursor machine to page in history and seek to the
   row — without touching `window.location`.
3. The host only pages in about **one history page (~5 turns) per seek**, so the
   plugin keeps toggling the hash to an already-loaded turn and back to the
   target, pulling one page at a time until the target row mounts.

Rows that are already mounted are scrolled locally for an instant jump.

## Build

```sh
npm install
npm run build      # -> dist/gui-experimental.cjs
```

After changing the source, rebuild and reload the plugin in OpenCode Desktop
(Settings → Extensions → Plugins → Reload) or restart the app.

## License

MIT © meiyx7
