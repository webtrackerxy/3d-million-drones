import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { build } from "esbuild";
import { loadEnv } from "vite";
import assert from "node:assert/strict";
const root = fileURLToPath(new URL("../../", import.meta.url));
// Same public browser-token setting as the Vite production build. Never load the reference repo.
const env = loadEnv("production", resolve(root, "apps/sky"), "VITE_CESIUM_ION_TOKEN");
const output = await build({
  entryPoints: [resolve(root, "apps/sky/src/main.ts")],
  bundle: true,
  write: false,
  minify: true,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  define: {
    "import.meta.env.VITE_CESIUM_ION_TOKEN": JSON.stringify(env.VITE_CESIUM_ION_TOKEN ?? ""),
  },
  plugins: [
    {
      name: "webgpu",
      setup(b) {
        b.onResolve({ filter: /^three$/ }, () => ({
          path: resolve(root, "node_modules/three/build/three.webgpu.js"),
        }));
      },
    },
  ],
});
const css = await readFile(resolve(root, "apps/sky/src/style.css"), "utf8");
const inlineScript = output.outputFiles[0].text.replaceAll(
  "</script",
  "<\\/script",
);
const html = (await readFile(resolve(root, "apps/sky/index.html"), "utf8"))
  .replace(
    /<link\b[^>]*href="\.\/src\/style\.css"[^>]*>/,
    `<style>${css}</style>`,
  )
  .replace(/<script\b[^>]*src="\.\/src\/main\.ts"[^>]*><\/script>/, "")
  .replace("</body>", () => `<script>${inlineScript}</script></body>`);
assert(
  html.includes("<style>") && !/\.\/src\/(style\.css|main\.ts)/.test(html),
  "Offline HTML retained an external source reference",
);
assert(
  html.includes(inlineScript),
  "HTML embedding changed JavaScript dollar sequences",
);
await mkdir(resolve(root, "dist"), { recursive: true });
await writeFile(resolve(root, "dist/index.html"), html);
console.log(
  `Flight demo: dist/index.html (${Buffer.byteLength(html)} bytes). Local London works offline with its london/ folder. Optional Photo uses HTTP/HTTPS and internet, through Cesium ion or the Google Map Tiles API.`,
);

await cp(
  resolve(root, "apps/sky/public/london"),
  resolve(root, "dist/london"),
  { recursive: true },
);
await cp(resolve(root, "apps/sky/public/draco"), resolve(root, "dist/draco"), {
  recursive: true,
});
await cp(resolve(root, "apps/sky/public/licenses"), resolve(root, "dist/licenses"), {
  recursive: true,
});
await cp(resolve(root, "apps/sky/public/drones"), resolve(root, "dist/drones"), {
  recursive: true,
});
