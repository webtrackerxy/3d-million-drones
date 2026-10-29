import { test } from "node:test";
import assert from "node:assert/strict";
import { referenceContacts, COLLISION_FIXTURE } from "./collision-reference.ts";
test("collision fixture independently distinguishes contact, proximity, negative-grid boundaries and height", () => {
  assert.deepEqual(referenceContacts(COLLISION_FIXTURE, 0), {
    contactPairs: 3,
    nearPairs: 4,
    selectedContacts: 2,
    selectedNear: 2,
  });
  assert.deepEqual(referenceContacts([[0, 0, 0]], 0), {
    contactPairs: 0,
    nearPairs: 0,
    selectedContacts: 0,
    selectedNear: 0,
  });
  const crowded = Array.from(
    { length: 6 },
    () => [0, 0, 0] as [number, number, number],
  );
  assert.deepEqual(referenceContacts(crowded, 2), {
    contactPairs: 15,
    nearPairs: 0,
    selectedContacts: 5,
    selectedNear: 0,
  });
});
