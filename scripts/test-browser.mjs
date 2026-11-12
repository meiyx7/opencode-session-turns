import { build } from "vite"
import solid from "vite-plugin-solid"
import { writeFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import assert from "node:assert/strict"

const dir = await mkdtemp(join(tmpdir(), "opencode-turns-browser-"))
try {
  const bundle = await build({
    configFile: false, logLevel: "error", plugins: [solid(), {
      name: "fixture", enforce: "pre",
      resolveId(id) { if (id === "@opencode/plugin/gui") return "\0fixture-gui" },
      load(id) { if (id === "\0fixture-gui") return `
        export const Slot = Symbol(), Style = Symbol(), Command = Symbol();
        export const Plugin = { define: (value) => value };
        export const usePlugin = () => globalThis.__ctx;
      ` },
    }],
    build: { write: false, minify: false, target: "es2022", lib: {
      entry: "tests/browser-fixture.tsx", formats: ["es"], fileName: "fixture",
    } },
  })
  const path = join(dir, "fixture.html")
  const outputs = (Array.isArray(bundle) ? bundle : [bundle]).flatMap((item) => item.output)
  const code = outputs.find((item) => item.type === "chunk" && item.isEntry).code
  await writeFile(path, `<meta charset="utf-8"><pre id="test-results">pending</pre><script type="module">${code.replaceAll("</script>", "<\\/script>")}</script>`)
  if (process.env.COMPILE_ONLY) {
    console.log("Browser fixture compiled successfully; execution skipped (COMPILE_ONLY).")
    process.exitCode = 0
  } else {
    const chrome = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    const child = spawn(chrome, ["--headless", "--disable-gpu", "--no-first-run", "--disable-background-networking",
      `--user-data-dir=${join(dir, "profile")}`, "--dump-dom", "--virtual-time-budget=12000", `file://${path}`], { stdio: ["ignore", "pipe", "pipe"] })
    let output = "", errors = ""
    child.stdout.on("data", (value) => { output += value })
    child.stderr.on("data", (value) => { errors += value })
    const timer = setTimeout(() => child.kill("SIGKILL"), 30000)
    const exit = await new Promise((resolve, reject) => {
      child.on("error", reject); child.on("exit", (code, signal) => resolve({ code, signal }))
    })
    clearTimeout(timer)
    const raw = output.match(/<pre id="test-results">(.*?)<\/pre>/s)?.[1]
    assert.ok(raw && raw !== "pending", `Browser fixture did not finish (${JSON.stringify(exit)}): ${errors.slice(-1500)}`)
    const result = JSON.parse(raw.replaceAll("&quot;", '"').replaceAll("&amp;", "&").replaceAll("&gt;", ">").replaceAll("&lt;", "<"))
    console.log(JSON.stringify(result, null, 2))
    assert.equal(result.ok, true)
  }
} finally {
  await rm(dir, { recursive: true, force: true })
}
