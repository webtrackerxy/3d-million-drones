import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const manifest = JSON.parse(
  await readFile(
    new URL("../../assets/city/canary-wharf/manifest.json", import.meta.url),
    "utf8",
  ),
);
const folder = new URL("../../reports/city-tests/", import.meta.url);
for (const name of [
  "city-correctness.json",
  "city-backdrop.json",
  "city-million-stress.json",
]) {
  const r = JSON.parse(await readFile(new URL(name, folder), "utf8"));
  assert(r.passed && r.errors.length === 0, `${name} failed`);
  const clearance = r.city?.clearance ?? r.clearance;
  assert.equal(clearance.obstacleSha256, manifest.data.sha256);
  assert(
    clearance.passed && clearance.minimumModelGapM >= clearance.requiredMarginM,
  );
  if (r.type === "flight-correctness") {
    assert.equal(r.scenario, "city");
    assert(
      r.normal.passed &&
        r.fixtures.passed &&
        r.pausePassed &&
        r.lifecyclePassed,
    );
    assert.equal(r.counts[3], r.population);
    assert.equal(r.counts[4], 0);
  } else {
    assert.equal(r.entries.length, 6);
    assert(
      r.entries.every(
        (e) =>
          e.countPassed &&
          e.reference.passed &&
          e.physicalPixels[0] === 1920 &&
          e.physicalPixels[1] === 1080,
      ),
    );
    for (let repeat = 1; repeat <= 3; repeat++)
      assert.deepEqual(
        r.entries.filter((e) => e.repeat === repeat).map((e) => e.cityVisible),
        [false, true],
      );
  }
  assert(r.screenshot.startsWith("data:image/png;base64,"));
  const png = Buffer.from(r.screenshot.split(",")[1], "base64");
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  await writeFile(new URL(name.replace(".json", ".png"), folder), png);
  console.log(
    `PASS ${name}: captured PNG and correctness/clearance/count audits`,
  );
}
