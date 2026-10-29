import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const root = new URL("../../", import.meta.url),
  folder = new URL("reports/london-tests/", root);
const manifest = JSON.parse(
  await readFile(new URL("assets/city/london/manifest.json", root), "utf8"),
);
const report = JSON.parse(
  await readFile(new URL("london-million-correctness.json", folder), "utf8"),
);
assert(
  report.passed &&
    report.scenario === "london" &&
    report.population === 1_000_000,
);
assert(
  report.normal.passed &&
    report.fixtures.passed &&
    report.pausePassed &&
    report.lifecyclePassed,
);
assert.equal(report.normal.samples + report.fixtures.samples, 4192);
assert.equal(report.counts[3], report.population);
assert.equal(
  report.counts.slice(0, 3).reduce((s, v) => s + v, 0),
  report.population,
);
assert.equal(report.counts[4], 0);
assert.deepEqual(report.errors, []);
assert.equal(report.city.clearance.obstacleSha256, manifest.dataSha256);
assert(
  report.city.clearance.passed &&
    report.city.clearance.minimumModelGapM >=
      report.city.clearance.requiredMarginM,
);
assert.equal(report.city.geometry.sourceTiles, 1820);
assert(report.screenshot.startsWith("data:image/png;base64,"));
const bytes = Buffer.from(report.screenshot.split(",")[1], "base64");
assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
await writeFile(new URL("london-million-overview.png", folder), bytes);
console.log(
  "PASS: London 1M pose/count/pause/allocation/clearance audits; extracted credited overview.",
);
