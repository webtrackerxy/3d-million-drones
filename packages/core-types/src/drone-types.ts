export const DRONE_TYPES = [
  { id: "scifi-drone", name: "Sci-fi drone", fullTriangles: 360, lowTriangles: 36 },
  { id: "quadcopter-original", name: "Quadcopter", fullTriangles: 5036, lowTriangles: 84 },
  { id: "inspection-drone", name: "Inspection drone", fullTriangles: 1252, lowTriangles: 148 },
] as const;
export const DRONE_TYPE_COUNT = DRONE_TYPES.length;
// Shared prepared-asset swept envelope; asset fixtures enforce this contract.
export const DRONE_ENVELOPE_RADIUS_M = 1.027;
export function droneType(id: number) {
  if (!Number.isInteger(id) || id < 0) throw new Error("Invalid drone ID");
  return id % DRONE_TYPE_COUNT;
}
export function droneTypeCounts(population: number) {
  if (!Number.isInteger(population) || population < 0 || population > 1_000_000)
    throw new Error("Invalid drone population");
  return DRONE_TYPES.map((_, type) => Math.floor((population + 2 - type) / 3));
}
