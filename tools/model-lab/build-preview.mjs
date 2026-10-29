import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../", import.meta.url));
const folder = resolve(root, "tools/model-lab");
const manifest = JSON.parse(
  await readFile(resolve(root, "assets/drones/sources.json"), "utf8"),
);
const models = {};
for (const model of manifest.models)
  models[model.id] = (
    await readFile(resolve(root, "assets/drones", model.file))
  ).toString("base64");
const { outputFiles } = await build({
  entryPoints: [resolve(folder, "lab.js")],
  bundle: true,
  write: false,
  minify: true,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  plugins: [
    {
      name: "webgpu-three",
      setup(bundler) {
        bundler.onResolve({ filter: /^three$/ }, () => ({
          path: resolve(root, "node_modules/three/build/three.webgpu.js"),
        }));
      },
    },
  ],
  define: { "process.env.NODE_ENV": '"production"' },
});
const html = (await readFile(resolve(folder, "index.html"), "utf8"))
  .replace(
    '<link rel="stylesheet" href="/lab.css" />',
    `<style>${await readFile(resolve(folder, "lab.css"), "utf8")}</style>`,
  )
  .replace(/\s*<script type="importmap">[\s\S]*?<\/script>/, "")
  .replace('<script type="module" src="/lab.js"></script>', "")
  .replace(
    "</body>",
    `<script type="application/json" id="offline-data">${JSON.stringify({ manifest, models }).replaceAll("<", "\\u003c")}</script><script>${outputFiles[0].text.replaceAll("</script", "<\\/script")}</script></body>`,
  );
await mkdir(resolve(root, "reports/model-tests"), { recursive: true });
await writeFile(resolve(root, "reports/model-tests/model-lab.html"), html);
console.log(
  `Wrote self-contained reports/model-tests/model-lab.html (${Buffer.byteLength(html)} bytes). Open directly in a WebGPU browser; no server or network required.`,
);
