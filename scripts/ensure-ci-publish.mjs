// Releases must go through GitHub Actions (.github/workflows/publish.yml).
// This guard fails a local `npm publish`, so a version can only ship from CI:
// bump the version and push a `v*` tag; the workflow builds and publishes.
const inActions = process.env.GITHUB_ACTIONS === "true"

if (!inActions) {
  console.error(
    [
      "",
      "✖ 已禁止本地发布（npm publish）。",
      "  只通过 GitHub Actions 发布：bump 版本后推送 v* tag，由 .github/workflows/publish.yml 构建并发布。",
      "  Local `npm publish` is blocked. Publish by pushing a v* tag; GitHub Actions does the rest.",
      "",
    ].join("\n"),
  )
  process.exit(1)
}
