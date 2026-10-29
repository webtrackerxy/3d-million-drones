import type { BufferAttribute, WebGPURenderer } from "three/webgpu";
import {
  Fn,
  If,
  Loop,
  Break,
  atomicStore,
  atomicLoad,
  atomicAdd,
  atomicFunc,
  instancedArray,
  storage,
  uint,
  ivec3,
  float,
  instanceIndex,
  uniform,
} from "three/tsl";
import type { Node } from "three/webgpu";
import prepared from "../../../assets/drones/prepared/scifi-drone.json";
import { releaseStorage } from "./release-storage.ts";

export type CollisionScope = "fleet" | "selected";
export interface CollisionStats {
  scope: CollisionScope;
  population: number;
  selectedId: number;
  contactPairs: number;
  nearPairs: number;
  selectedContacts: number;
  selectedNear: number;
  truncatedQueries: number;
  complete: boolean;
  selectedComplete: boolean;
  queries: number;
  contactDistanceM: number;
  nearDistanceM: number;
}
// Snapshot diagnostics, not response/avoidance. Grid construction and bounded neighbour
// queries stay on the GPU; only six counters are read back per sample.
export function createCollisionMonitor(
  renderer: WebGPURenderer,
  poses: BufferAttribute,
  population: number,
  options: { bucketCount?: number; maxVisits?: number } = {},
) {
  const bucketCount = options.bucketCount ?? 1 << 20,
    maxVisits = options.maxVisits ?? 256,
    contact = prepared.boundingRadius * 2,
    near = 4;
  if (
    !Number.isInteger(population) ||
    population < 1 ||
    population > 1_000_000 ||
    !Number.isInteger(bucketCount) ||
    bucketCount < 2 ||
    (bucketCount & (bucketCount - 1)) !== 0 ||
    bucketCount > 1 << 22 ||
    !Number.isInteger(maxVisits) ||
    maxVisits < 1 ||
    maxVisits > 1024 ||
    contact > near
  )
    throw new Error("Invalid collision monitor capacity");
  const heads = instancedArray(new Uint32Array(bucketCount), "uint").toAtomic(),
    links = instancedArray(new Uint32Array(population), "uint"),
    counters = instancedArray(new Uint32Array(6), "uint").toAtomic();
  const positions = storage(poses, "vec4", population * 2).toReadOnly(),
    selected = uniform(42, "uint"),
    empty = uint(0xffffffff);
  const hash = (p: Node<"ivec3">) =>
    p.x
      .toUint()
      .mul(uint(73856093))
      .bitXor(p.y.toUint().mul(uint(19349663)))
      .bitXor(p.z.toUint().mul(uint(83492791)))
      .bitAnd(uint(bucketCount - 1));
  const clear = Fn(() => {
    atomicStore(heads.element(instanceIndex), empty);
  })().compute(bucketCount);
  const reset = Fn(() => {
    for (let i = 0; i < 6; i++) atomicStore(counters.element(uint(i)), uint(0));
  })().compute(1);
  const insert = Fn(() => {
    const id = instanceIndex,
      cell = ivec3(positions.element(id.mul(2)).xyz.div(near).floor());
    // Pinned TSL exposes generic atomicFunc but has no atomicExchange wrapper.
    // WGSL's standard exchange returns the previous head for this linked list.
    links
      .element(id)
      .assign(
        atomicFunc(
          "atomicExchange" as Parameters<typeof atomicFunc>[0],
          heads.element(hash(cell)),
          id,
        ),
      );
  })().compute(population);
  const query = (id: Node<"uint">, allPairs: boolean) => {
    const p = positions.element(id.mul(2)).xyz.toVar(),
      cell = ivec3(p.div(near).floor()).toVar();
    const visited = uint(0).toVar(),
      contacts = uint(0).toVar(),
      nearby = uint(0).toVar(),
      pairs = uint(0).toVar(),
      nearPairs = uint(0).toVar(),
      truncated = uint(0).toVar();
    for (let x = -1; x <= 1; x++)
      for (let y = -1; y <= 1; y++)
        for (let z = -1; z <= 1; z++) {
          const neighbour = cell.add(ivec3(x, y, z)),
            candidate = atomicLoad(heads.element(hash(neighbour))).toVar();
          Loop(maxVisits, () => {
            If(
              candidate
                .equal(empty)
                .or(visited.greaterThanEqual(uint(maxVisits))),
              () => {
                Break();
              },
            );
            const q = positions.element(candidate.mul(2)).xyz,
              qCell = ivec3(q.div(near).floor());
            If(
              candidate
                .notEqual(id)
                .and(qCell.x.equal(neighbour.x))
                .and(qCell.y.equal(neighbour.y))
                .and(qCell.z.equal(neighbour.z)),
              () => {
                const d2 = q.sub(p).dot(q.sub(p));
                If(d2.lessThanEqual(float(contact * contact)), () => {
                  contacts.addAssign(1);
                  if (allPairs)
                    If(candidate.greaterThan(id), () => {
                      pairs.addAssign(1);
                    });
                }).ElseIf(d2.lessThanEqual(float(near * near)), () => {
                  nearby.addAssign(1);
                  if (allPairs)
                    If(candidate.greaterThan(id), () => {
                      nearPairs.addAssign(1);
                    });
                });
              },
            );
            visited.addAssign(1);
            candidate.assign(links.element(candidate));
          });
          If(candidate.notEqual(empty), () => {
            truncated.assign(1);
          });
        }
    if (allPairs) {
      If(pairs.greaterThan(0), () => {
        atomicAdd(counters.element(uint(0)), pairs);
      });
      If(nearPairs.greaterThan(0), () => {
        atomicAdd(counters.element(uint(1)), nearPairs);
      });
    }
    If(id.equal(selected), () => {
      atomicStore(counters.element(uint(2)), contacts);
      atomicStore(counters.element(uint(3)), nearby);
      atomicStore(counters.element(uint(5)), truncated);
    });
    If(truncated.equal(uint(1)), () => {
      atomicAdd(counters.element(uint(4)), uint(1));
    });
  };
  const fleetQuery = Fn(() => {
      query(instanceIndex, true);
    })().compute(population),
    selectedQuery = Fn(() => {
      query(selected, false);
    })().compute(1);
  let disposed = false;
  return {
    passes: [clear, reset, insert, fleetQuery, selectedQuery],
    bytes: bucketCount * 4 + population * 4 + 24,
    async sample(
      id: number,
      scope: CollisionScope = "fleet",
    ): Promise<CollisionStats> {
      if (disposed || !Number.isInteger(id) || id < 0 || id >= population)
        throw new Error("Collision monitor unavailable for selected ID");
      selected.value = id;
      renderer.compute([
        clear,
        reset,
        insert,
        scope === "fleet" ? fleetQuery : selectedQuery,
      ]);
      const values = new Uint32Array(
        (await renderer.getArrayBufferAsync(counters.value)) as ArrayBuffer,
      );
      return {
        scope,
        population,
        selectedId: id,
        contactPairs: values[0],
        nearPairs: values[1],
        selectedContacts: values[2],
        selectedNear: values[3],
        truncatedQueries: values[4],
        complete: values[4] === 0,
        selectedComplete: values[5] === 0,
        queries: scope === "fleet" ? population : 1,
        contactDistanceM: contact,
        nearDistanceM: near,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const pass of [clear, reset, insert, fleetQuery, selectedQuery])
        pass.dispose();
      releaseStorage(renderer, [heads.value, links.value, counters.value]);
    },
  };
}
