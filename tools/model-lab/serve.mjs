import { createServer } from "node:http";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const port = Number(process.env.MODEL_LAB_PORT ?? 5174);
const origin = `http://127.0.0.1:${port}`;
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".glb": "model/gltf-binary",
  ".png": "image/png",
  ".txt": "text/plain",
};
const modelIds = ["scifi-drone", "quadcopter-original", "inspection-drone"];
const permittedReports = new Set([
  "browser.json",
  "contact-sheet.png",
  ...modelIds.flatMap((id) =>
    ["above", "below", "front"].map((view) => `${id}-${view}.png`),
  ),
]);

createServer(async (request, response) => {
  try {
    const url = new URL(request.url, origin);
    if (request.method === "POST" && url.pathname.startsWith("/__report/")) {
      const name = decodeURIComponent(url.pathname.slice("/__report/".length));
      if (request.headers.origin !== origin || !permittedReports.has(name)) {
        response.writeHead(403).end("Report destination not allowed");
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 5_000_000) {
          response.writeHead(413).end("Report too large");
          return;
        }
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      if (name.endsWith(".json")) JSON.parse(bytes.toString("utf8"));
      else if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
        throw new Error("Expected PNG");
      await writeFile(resolve(root, "reports/model-tests", name), bytes);
      response.writeHead(200, { "Content-Type": "text/plain" }).end("Saved");
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end();
      return;
    }
    let base;
    let relative;
    if (
      url.pathname === "/" ||
      url.pathname === "/lab.js" ||
      url.pathname === "/lab.css"
    ) {
      base = resolve(root, "tools/model-lab");
      relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    } else if (url.pathname.startsWith("/vendor/three/")) {
      base = resolve(root, "node_modules/three");
      relative = decodeURIComponent(
        url.pathname.slice("/vendor/three/".length),
      );
    } else if (url.pathname.startsWith("/assets/drones/")) {
      base = resolve(root, "assets/drones");
      relative = decodeURIComponent(
        url.pathname.slice("/assets/drones/".length),
      );
    } else if (url.pathname.startsWith("/reports/model-tests/")) {
      base = resolve(root, "reports/model-tests");
      relative = decodeURIComponent(
        url.pathname.slice("/reports/model-tests/".length),
      );
      if (!/^[a-z0-9-]+\.(json|png)$/.test(relative)) {
        response.writeHead(404).end();
        return;
      }
    } else {
      response.writeHead(404).end();
      return;
    }
    const destination = resolve(base, relative);
    if (!destination.startsWith(`${base}${sep}`)) {
      response.writeHead(403).end();
      return;
    }
    if (!(await stat(destination)).isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": types[extname(destination)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(
      request.method === "HEAD" ? undefined : await readFile(destination),
    );
  } catch (error) {
    response.writeHead(error.code === "ENOENT" ? 404 : 500).end(error.message);
  }
}).listen(port, "127.0.0.1", () =>
  console.log(
    `Model lab: ${origin} — open /?test=1 for browser tests and saved previews.`,
  ),
);
