import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const folder = fileURLToPath(
  new URL("../../reports/model-tests/", import.meta.url),
);
const html = await readFile(resolve(folder, "browser-report.html"), "utf8");
const json = JSON.parse(
  await readFile(resolve(folder, "browser.json"), "utf8"),
);
const embedded = html.match(/<pre>([\s\S]*?)<\/pre>/)?.[1];
assert(embedded, "The visual bundle has no embedded JSON report");
const entities = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };
assert.deepEqual(
  JSON.parse(
    embedded.replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => entities[name]),
  ),
  json,
  "JSON and visual bundle must come from the same test run",
);
assert(
  json.passed &&
    json.contactSheetAllBoundsInFrustum &&
    json.errors.length === 0,
  "Browser checks failed",
);
const expected = new Set([
  "contact-sheet.png",
  ...json.models.flatMap((model) => model.views.map((view) => view.image)),
]);
let count = 0;
for (const match of html.matchAll(
  /<figure><figcaption>([^<]+)<\/figcaption><img src="data:image\/png;base64,([^"]+)"/g,
)) {
  const [, name, base64] = match;
  assert(expected.delete(name), `Unexpected/duplicate preview: ${name}`);
  assert(/^[a-z0-9-]+\.png$/.test(name), `Unsafe preview name: ${name}`);
  const png = Buffer.from(base64, "base64");
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  await writeFile(resolve(folder, name), png);
  count++;
}
assert.equal(expected.size, 0, "The visual bundle is missing expected images");
console.log(
  `PASS: ${count} PNGs extracted; browser JSON and visual bundle match.`,
);
