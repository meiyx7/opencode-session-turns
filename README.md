# opencode-timeline-gui

**OpenCode Desktop 插件：在会话右缘列出每一轮的「用户提问」，悬停展开，点击即刻跳转到那一条消息。**

An OpenCode Desktop plugin that adds a slim rail on the right edge of the
conversation, listing every user turn of the current session. Hover to expand;
click a turn to jump straight to that message.

> 本包原名 `opencode-session-turns`，自 0.2.0 起更名为 `opencode-timeline-gui`。
> 已安装旧包的话，把配置里的包名换成新名字即可，功能不变。

适用 OpenCode Desktop 2.2.6（以预构建的 `./gui-experimental` 包形式加载）。

```
┌─ 会话轮次 (12) ─────────────┐
│ 09:14  #1  帮我看看这个报错… │
│ 09:22  #2  那改成异步呢？     │
│ 09:35  #3  继续              │
│ ...                         │
└─────────────────────────────┘
```

## 功能

- 列出当前会话的每一轮用户提问（从会话消息接口分页拉取，`type=user`）。
- 鼠标移到窗口右缘的细条上自动展开，移开自动收起；长历史跳转期间面板保持展开。
- **搜索轮次**：≥ 8 轮时面板顶部出现搜索框，按关键字即时过滤（匹配数显示在标题里）；`↑`/`↓` 在结果间移动光标，`Enter` 跳转，无鼠标也能导航。
- **面板固定**：标题栏图钉按钮或 `⌘⌥P`（斜杠命令 `/turns-pin`）把面板钉住，鼠标移开不收起；`Esc` 先解固定、再关面板。
- 点击任意一轮，**跳转到对应消息**——包括很久以前、尚未渲染的历史轮次。
- **历史批量加载**：使用当前会话 `server.data.session.message.loadMore({ all: true })` 填充宿主共享缓存。SDK 每次最多读 200 条消息、统一发布，不经过界面的逐页冷却。
- **请求复用**：打开会话后可在后台加载历史；点击轮次时复用同一个请求，目标已经在缓存中就直接定位。预热不切换地址、不修改滚动位置。
- **长会话目录缓存**：窗口内保留最多 8 个会话、合计 16000 条轮次预览；返回会话时立即显示，后台只补新轮次。离开期间新增超过 50 轮也会继续分页补齐。
- 加载时显示「加载历史中 / 定位中 · 已用 Xs」。批量请求结束前无法取得可靠的进度，因此不显示剩余时间和百分比。
- `Esc` 或 × 取消跳转及其历史请求；切换会话时同步取消旧任务。历史加载超时 20 秒，可重新点击重试。
- 定位成功后精准描边闪烁**那一条用户气泡**（跟随气泡自身圆角），不再整行填色。
- 自动高亮当前视口所在的轮次（IntersectionObserver 驱动，后台窗口零开销）。
- 跨天会话的时间标注会带上「昨天」或日期，不再只有 `HH:mm` 造成歧义。
- 尊重系统的「减弱动态效果」（`prefers-reduced-motion`）：保留状态色彩，去掉动画。
- 斜杠命令 `/turns`、快捷键 `⌘⌥R`（Windows/Linux 为 `Ctrl+Alt+R`）展开轮次条。

## 安装

把包名加入 `opencode.json` 的 `plugins` 列表，OpenCode 启动时会自动从 npm 安装：

```json
{
  "plugins": ["opencode-timeline-gui"]
}
```

然后重启 OpenCode Desktop（GUI bundle 在窗口启动时加载）。

## 使用

- 把鼠标移到会话右侧的细条上展开；
- 或按 `⌘⌥R` / 输入 `/turns` 展开；
- 点击某一轮即可跳到那条消息。

## 实现原理

OpenCode Desktop 的时间线按需挂载消息行；DOM 中没有某条消息，并不代表宿主缓存中也没有它。轮次目录通过 `message.list({ type: "user" })` 获取，但这只会生成插件目录，不会填充宿主历史缓存。

v27 将两个阶段分开处理：

1. 目录按 200 条用户消息分页获取，并在窗口内保留轻量缓存；新消息直接复用宿主已有的响应式数据，不再额外订阅 SSE。
2. 目标不在宿主缓存时，调用公开的 `session.server.data.session.message.loadMore(sessionID, { all: true, signal })`。SDK 以每批 200 条补齐历史、只发布一次更新，并复用宿主已在进行的分页请求。
3. 历史就绪后，通过合法内存路由的链接点击驱动宿主定位。插件只观察目标行挂载，不再把虚拟列表滚动当成分页进度，也不再全量扫描目录来估算时间。

后台预加载和点击共用一个请求；切换目标使旧定位失效，但可继续复用加载中的历史。会话切换、取消和卸载都会中止请求、观察器及旧回调。未提供批量接口的旧宿主保留内存路由分页的兼容路径。

**批量加载会读取完整旧历史**，包括回复和工具消息。实际耗时仍取决于历史体量和服务器响应；不会保证任意规模的会话都瞬时完成。插件不缓存第二份完整历史。

桌面端使用内存路由，`window.location` 仍可能是 `oc://renderer/index.html`，所以不能直接修改 `window.location.hash`。本插件使用 `ctx.router.path()` 构造内部链接，保留宿主自己的路由拦截和虚拟列表定位行为。

## 构建

```sh
npm install
npm test           # 16 项回归测试，含真实 SDK 数据层集成
npm run build      # -> dist/gui-experimental.cjs
```

改完源码后重新构建，并在 OpenCode Desktop 里 Reload 插件
（Settings → Extensions → Plugins → Reload）或重启应用。

浏览器交互测试：

```sh
npm run test:browser
# 非 macOS 可通过 CHROME_BIN 指定 Chrome/Chromium 可执行文件
```

测试夹具使用 1000 轮目录及虚拟时间线，检查预热期间无导航/滚动写入、重复点击、改选已挂载目标、切换会话、返回会话增量请求、实时新提问和搜索。它不替代 OpenCode Desktop 实机验收。

开发本地修改时，确认 OpenCode 加载的是本地插件。配置仍指向 `opencode-timeline-gui@0.2.5` 等 npm 版本时，重建仓库本身不会更新 npm 包。本次源码优化没有发布到 npm。

## 发布

版本发布只通过 GitHub Actions（`.github/workflows/publish.yml`）；本地 `npm publish` 已被 `prepublishOnly` 守卫禁止：

```sh
npm version patch   # 或 minor / major：自动改版本、提交并打 v* tag
git push --follow-tags origin main
```

CI 会校验 tag 与 `package.json` 版本一致，随后构建并发布到 npm。

## 许可证

MIT © meiyx7
