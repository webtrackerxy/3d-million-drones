import { defineConfig } from "vite";
import { resolve } from "node:path";
export default defineConfig({
  root: resolve(import.meta.dirname),
  resolve: {
    alias: [
      {
        find: /^three$/,
        replacement: resolve(
          import.meta.dirname,
          "../../node_modules/three/build/three.webgpu.js",
        ),
      },
    ],
  },
  build: {
    outDir: resolve(import.meta.dirname, "../../dist/web"),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5175,
    fs: { allow: [resolve(import.meta.dirname, "../..")] },
  },
});
