import type { Vec3 } from "../../core-types/src/index.ts";
// Independent brute-force reference for small fixtures, never the live fleet loop.
export function referenceContacts(
  points: Vec3[],
  selected: number,
  contactM = 2.054,
  nearM = 4,
) {
  let contactPairs = 0,
    nearPairs = 0,
    selectedContacts = 0,
    selectedNear = 0;
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++) {
      const d = Math.hypot(...points[i].map((v, k) => v - points[j][k]));
      if (d <= contactM) {
        contactPairs++;
        if (i === selected || j === selected) selectedContacts++;
      } else if (d <= nearM) {
        nearPairs++;
        if (i === selected || j === selected) selectedNear++;
      }
    }
  return { contactPairs, nearPairs, selectedContacts, selectedNear };
}
export const COLLISION_FIXTURE: Vec3[] = [
  [-0.2, 10, 0],
  [1.5, 10, 0],
  [3.5, 10, 0],
  [20, 10, 0],
  [-0.2, 11.5, 0],
  [-4.1, 10, 0],
];
