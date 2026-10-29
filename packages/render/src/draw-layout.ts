import { DRONE_TYPE_COUNT, droneType, droneTypeCounts } from "../../core-types/src/drone-types.ts";

// Six bounded model lists plus one shared marker list. LOD caps apply across types.
export function droneDrawLayout(population: number) {
  if (!Number.isInteger(population) || population < 1 || population > 1_000_000)
    throw new Error("Invalid render population");
  const lodCaps = [Math.min(population, 4096), Math.min(population, 32768), population];
  const capacities = [...Array(DRONE_TYPE_COUNT).fill(lodCaps[0]), ...Array(DRONE_TYPE_COUNT).fill(lodCaps[1]), population] as number[];
  let size = 0;
  const offsets = capacities.map(cap => { const start = size; size += cap; return start; });
  return { lodCaps, capacities, offsets, size, marker: DRONE_TYPE_COUNT * 2 };
}

// Audit actual GPU output on demand, never in the frame loop.
export function auditDroneDraws(population: number, ids: Uint32Array, args: Uint32Array, allVisible: boolean) {
  const layout = droneDrawLayout(population), seen = new Uint8Array(population);
  const typeCounts = [0, 0, 0], lodCounts = [0, 0, 0], drawCounts: number[] = [];
  let duplicates = 0, invalid = 0, wrongType = 0, submitted = 0;
  if (ids.length !== layout.size || args.length !== layout.offsets.length * 5)
    throw new Error("Invalid draw audit buffer size");
  for (let bucket = 0; bucket < layout.offsets.length; bucket++) {
    const count = args[bucket * 5 + 1]; drawCounts.push(count);
    if (count > layout.capacities[bucket]) { invalid++; continue; }
    const lod = bucket === layout.marker ? 2 : Math.floor(bucket / DRONE_TYPE_COUNT);
    lodCounts[lod] += count;
    for (let slot = 0; slot < count; slot++) {
      const id = ids[layout.offsets[bucket] + slot]; submitted++;
      if (id >= population) { invalid++; continue; }
      if (seen[id]) duplicates++; seen[id] = 1;
      const type = droneType(id); typeCounts[type]++;
      if (bucket !== layout.marker && type !== bucket % DRONE_TYPE_COUNT) wrongType++;
    }
  }
  const missing = allVisible ? population - seen.reduce((sum, v) => sum + v, 0) : 0;
  const expectedTypes = droneTypeCounts(population);
  return { submitted, drawCounts, lodCounts, typeCounts, expectedTypes, duplicates, invalid, wrongType, missing,
    passed: !duplicates && !invalid && !wrongType && !missing && lodCounts.every((n, i) => n <= layout.lodCaps[i]) && (!allVisible || typeCounts.every((n, i) => n === expectedTypes[i])) };
}
