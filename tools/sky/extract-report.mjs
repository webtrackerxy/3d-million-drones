import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const root = fileURLToPath(new URL("../../", import.meta.url)),
  folder = resolve(root, "reports/flight-tests");
for (const name of process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["flight-correctness.json", "overview-scaling.json"]) {
  assert(/^[a-z0-9-]+\.json$/.test(name));
  const report = JSON.parse(await readFile(resolve(folder, name), "utf8"));
  if (report.screenshot) {
    assert(report.screenshot.startsWith("data:image/png;base64,"));
    const png = Buffer.from(report.screenshot.split(",")[1], "base64");
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    await writeFile(resolve(folder, name.replace(".json", ".png")), png);
    console.log(`Extracted ${name.replace(".json", ".png")}`);
  }
  if (report.type === "flight-correctness") assert(report.passed);
  else {
    assert(!report.error);
    assert.equal(report.entries.length, 9);
    assert(report.entries.every((entry) => entry.countPassed));
    assert.equal(report.errors.length, 0);
  }
  console.log(`Checked ${name}`);
}
