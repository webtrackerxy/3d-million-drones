import {
  BufferGeometry,
  Float32BufferAttribute,
  Vector3,
  Vector4,
  PlaneGeometry,
  Frustum,
  Matrix4,
  Color,
} from "three";
import {
  Mesh,
  MeshStandardNodeMaterial,
  MeshBasicNodeMaterial,
  IndirectStorageBufferAttribute,
} from "three/webgpu";
import type {
  Node,
  Scene,
  PerspectiveCamera,
  WebGPURenderer,
} from "three/webgpu";
import {
  Fn,
  If,
  atomicAdd,
  atomicLoad,
  atomicStore,
  atomicSub,
  atomicMin,
  attribute,
  bitcast,
  cos,
  sin,
  float,
  uint,
  vec3,
  vec4,
  instancedArray,
  instanceIndex,
  uniform,
  uniformArray,
  varying,
  storage,
  select,
  mix,
  max,
  min,
  length,
  sqrt,
  positionLocal,
  normalLocal,
} from "three/tsl";
import type { RouteTable } from "../../flight/src/index.ts";
import type { FlightPose } from "../../flight/src/manual.ts";
import {
  WORLD_XZ_OFFSETS,
  SCHEDULED_START,
} from "../../core-types/src/index.ts";
import prepared from "../../../assets/drones/prepared/scifi-drone.json";
import quadcopter from "../../../assets/drones/prepared/quadcopter-original.json";
import inspection from "../../../assets/drones/prepared/inspection-drone.json";
import { DRONE_TYPES, DRONE_TYPE_COUNT } from "../../core-types/src/drone-types.ts";
import { droneDrawLayout, auditDroneDraws } from "./draw-layout.ts";
import { releaseStorage } from "./release-storage.ts";
const assets = [prepared, quadcopter, inspection];
const markerColor = new Color(0x243f50);

const asFloat = (word: Node<"uint">): Node<"float"> =>
  bitcast(word, "float") as unknown as Node<"float">;
const asUint = (word: Node<"float">): Node<"uint"> =>
  bitcast(word, "uint") as unknown as Node<"uint">;
const rotateQuaternion = (q: Node<"vec4">, v: Node<"vec3">) =>
  v.add(q.xyz.cross(q.xyz.cross(v).add(v.mul(q.w))).mul(2));
function quaternion(
  right: Node<"vec3">,
  up: Node<"vec3">,
  forward: Node<"vec3">,
) {
  const back = forward.negate(),
    trace = right.x.add(up.y).add(back.z),
    q = vec4(0, 0, 0, 1).toVar();
  If(trace.greaterThan(0), () => {
    const s = sqrt(trace.add(1)).mul(2);
    q.assign(
      vec4(
        up.z.sub(back.y).div(s),
        back.x.sub(right.z).div(s),
        right.y.sub(up.x).div(s),
        s.mul(0.25),
      ),
    );
  })
    .ElseIf(right.x.greaterThan(up.y).and(right.x.greaterThan(back.z)), () => {
      const s = sqrt(float(1).add(right.x).sub(up.y).sub(back.z)).mul(2);
      q.assign(
        vec4(
          s.mul(0.25),
          up.x.add(right.y).div(s),
          back.x.add(right.z).div(s),
          up.z.sub(back.y).div(s),
        ),
      );
    })
    .ElseIf(up.y.greaterThan(back.z), () => {
      const s = sqrt(float(1).add(up.y).sub(right.x).sub(back.z)).mul(2);
      q.assign(
        vec4(
          up.x.add(right.y).div(s),
          s.mul(0.25),
          back.y.add(up.z).div(s),
          back.x.sub(right.z).div(s),
        ),
      );
    })
    .Else(() => {
      const s = sqrt(float(1).add(back.z).sub(right.x).sub(up.y)).mul(2);
      q.assign(
        vec4(
          back.x.add(right.z).div(s),
          back.y.add(up.z).div(s),
          s.mul(0.25),
          right.y.sub(up.x).div(s),
        ),
      );
    });
  return q.normalize();
}

class DroneMaterial extends MeshStandardNodeMaterial {
  private place: () => unknown;
  private variant: number;
  constructor(place: () => unknown, variant: number) {
    super();
    this.place = place;
    this.variant = variant;
    this.vertexColors = true;
    this.roughness = 0.7;
    this.metalness = 0.05;
    this.side = 2;
  }
  override customProgramCacheKey() {
    return `${super.customProgramCacheKey()}|drone-${this.variant}`;
  }
  override setupPosition(): Node {
    this.place();
    return positionLocal;
  }
}
function geometry(type: number, lod: number) {
  const source = assets[type].lods[lod],
    g = new BufferGeometry();
  for (const name of ["position", "normal", "color"] as const)
    g.setAttribute(name, new Float32BufferAttribute(source[name], 3));
  g.setAttribute("rotor", new Float32BufferAttribute(source.rotor, 4));
  g.setIndex(Array.from({ length: source.position.length / 3 }, (_, i) => i));
  g.computeBoundingSphere();
  return g;
}

export function createDroneRenderer(
  renderer: WebGPURenderer,
  scene: Scene,
  words: Uint32Array,
  table: RouteTable,
) {
  const capacity = words.length / 8;
  const layout = droneDrawLayout(capacity);
  const records = instancedArray(words, "uint");
  const samples = instancedArray(table.samples, "vec4");
  const metadata = instancedArray(table.metadata, "uint");
  const poses = instancedArray(capacity * 2, "vec4");
  const state = instancedArray(new Uint32Array(capacity).fill(2), "uint");
  const visible = instancedArray(new Uint32Array(layout.size), "uint");
  const drawCounters = instancedArray(new Uint32Array(DRONE_TYPE_COUNT * 2), "uint").toAtomic();
  const counters = instancedArray(new Uint32Array(5), "uint").toAtomic();
  const statsAttribute = new IndirectStorageBufferAttribute(
    new Uint32Array(5),
    1,
  );
  const stats = storage(statsAttribute, "uint", 5);
  const geometries = [...assets.map((_, type) => geometry(type, 0)), ...assets.map((_, type) => geometry(type, 1)), new PlaneGeometry(1, 1)];
  const argsAttribute = new IndirectStorageBufferAttribute(
    Uint32Array.from(geometries.flatMap((g) => [g.index!.count, 0, 0, 0, 0])),
    1,
  );
  const args = storage(argsAttribute, "uint", geometries.length * 5);
  const timeMs = uniform(0, "uint"),
    timeSeconds = uniform(0);
  const selectedId = uniform(42, "uint");
  const manualId = uniform(0xffffffff, "uint"),
    manualPosition = uniform(new Vector3()),
    manualQuaternion = uniform(new Vector4(0, 0, 0, 1));
  const pickOrigin = uniform(new Vector3()),
    pickDirection = uniform(new Vector3(0, 0, -1)),
    pickLimit = uniform(180000),
    pickPixels = uniform(4);
  const pickState = instancedArray(new Uint32Array(2), "uint").toAtomic();
  const cameraPosition = uniform(new Vector3()),
    cameraRight = uniform(new Vector3(1, 0, 0)),
    cameraUp = uniform(new Vector3(0, 1, 0));
  const pixelsPerRadian = uniform(800),
    culling = uniform(1, "uint");
  const planeValues = Array.from({ length: 6 }, () => new Vector4());
  const planes = uniformArray(planeValues, "vec4" as const);
  const capValues = layout.lodCaps;

  const integrate = Fn(() => {
    const id = instanceIndex,
      at = id.mul(8),
      route = records.element(at).mul(8);
    const first = metadata.element(route),
      count = metadata.element(route.add(1));
    const routeLength = asFloat(metadata.element(route.add(2))),
      spacing = asFloat(metadata.element(route.add(3)));
    const flags = records.element(at.add(7)),
      start = records.element(at.add(3)),
      worldOffsets = flags.bitAnd(uint(WORLD_XZ_OFFSETS)).notEqual(uint(0));
    const elapsed = select(
      flags.bitAnd(uint(SCHEDULED_START)).notEqual(uint(0)),
      max(float(timeMs).sub(float(start)), 0),
      float(timeMs.sub(start)),
    ).mul(0.001);
    const raw = asFloat(records.element(at.add(2))).add(
      asFloat(records.element(at.add(4))).mul(elapsed),
    );
    const s = select(
      metadata.element(route.add(4)).equal(uint(1)),
      raw.mod(routeLength),
      max(0, min(raw, routeLength)),
    );
    const interval = uint(min(s.div(spacing).floor(), float(count.sub(2)))),
      base = first.add(interval).mul(3);
    const p0 = samples.element(base),
      p1 = samples.element(base.add(3));
    const t = s.sub(p0.w).div(p1.w.sub(p0.w));
    const forward = mix(
      samples.element(base.add(1)).xyz,
      samples.element(base.add(4)).xyz,
      t,
    )
      .normalize()
      .toVar();
    const candidate = mix(
      samples.element(base.add(2)).xyz,
      samples.element(base.add(5)).xyz,
      t,
    );
    const right = candidate
      .sub(forward.mul(candidate.dot(forward)))
      .normalize()
      .toVar();
    const up = right.cross(forward).normalize().toVar();
    const offsetA = asFloat(records.element(at.add(5))),
      offsetB = asFloat(records.element(at.add(6)));
    const position = mix(p0.xyz, p1.xyz, t).add(
      select(
        worldOffsets,
        vec3(offsetA, 0, offsetB),
        right.mul(offsetA).add(up.mul(offsetB)),
      ),
    );
    poses.element(id.mul(2)).assign(vec4(position, 1));
    poses.element(id.mul(2).add(1)).assign(quaternion(right, up, forward));
    // Exactly one interactive override, before culling, picking and collision queries.
    If(id.equal(manualId), () => {
      poses.element(id.mul(2)).assign(vec4(manualPosition, 1));
      poses.element(id.mul(2).add(1)).assign(manualQuaternion);
    });
  })().compute(capacity);

  const classify = Fn(() => {
    const id = instanceIndex,
      position = poses.element(id.mul(2)).xyz,
      inside = uint(1).toVar();
    for (let i = 0; i < 6; i++)
      If(
        culling
          .equal(uint(1))
          .and(
            planes
              .element(i)
              .xyz.dot(position)
              .add(planes.element(i).w)
              .lessThan(-prepared.boundingRadius),
          ),
        () => inside.assign(0),
      );
    If(inside.equal(uint(1)), () => {
      atomicAdd(counters.element(uint(3)), uint(1));
      const size = float(prepared.boundingRadius * 2)
        .mul(pixelsPerRadian)
        .div(max(length(cameraPosition.sub(position)), 0.01));
      const previous = state.element(id),
        meshCut = select(previous.equal(uint(0)), float(10.8), float(13.2)),
        lowCut = select(previous.lessThan(uint(2)), float(2.7), float(3.3));
      const bucket = select(
        size.greaterThanEqual(meshCut),
        uint(0),
        select(size.greaterThanEqual(lowCut), uint(1), uint(2)),
      ).toVar();
      state.element(id).assign(bucket);
      const caps = select(
        bucket.equal(uint(0)),
        uint(capValues[0]),
        select(bucket.equal(uint(1)), uint(capValues[1]), uint(capacity)),
      );
      const slot = atomicAdd(counters.element(bucket), uint(1)).toVar();
      If(slot.lessThan(caps), () => {
        If(bucket.equal(uint(2)), () => {
          visible.element(uint(layout.offsets[layout.marker]).add(slot)).assign(id);
        }).Else(() => {
          const type = id.mod(uint(DRONE_TYPE_COUNT));
          const drawBucket = bucket.mul(DRONE_TYPE_COUNT).add(type);
          const offset = select(bucket.equal(uint(0)), type.mul(capValues[0]), uint(capValues[0] * DRONE_TYPE_COUNT).add(type.mul(capValues[1])));
          const drawSlot = atomicAdd(drawCounters.element(drawBucket), uint(1));
          visible.element(offset.add(drawSlot)).assign(id);
        });
      }).Else(() => {
        atomicSub(counters.element(bucket), uint(1));
        const fallback = atomicAdd(counters.element(uint(2)), uint(1)).toVar();
        If(fallback.lessThan(uint(capacity)), () =>
          visible.element(uint(layout.offsets[layout.marker]).add(fallback)).assign(id),
        ).Else(() => atomicAdd(counters.element(uint(4)), uint(1)));
      });
    });
  })().compute(capacity);
  const writeArgs = Fn(() => {
    const i = instanceIndex;
    If(i.lessThan(uint(5)), () => {
      const value = atomicLoad(counters.element(i));
      stats.element(i).assign(value);
      If(i.equal(uint(2)), () => args.element(uint(layout.marker * 5 + 1)).assign(value));
      atomicStore(counters.element(i), uint(0));
    });
    const drawCount = atomicLoad(drawCounters.element(i));
    args.element(i.mul(5).add(1)).assign(drawCount);
    atomicStore(drawCounters.element(i), uint(0));
  })().compute(DRONE_TYPE_COUNT * 2);
  const poseRead = storage(poses.value, "vec4", capacity * 2).toReadOnly(),
    idsRead = storage(visible.value, "uint", layout.size).toReadOnly();
  const resetPick = Fn(() => {
    atomicStore(pickState.element(uint(0)), uint(0xffffffff));
    atomicStore(pickState.element(uint(1)), uint(0xffffffff));
  })().compute(1);
  const pickCandidate = Fn(() => {
    const delta = poseRead.element(instanceIndex.mul(2)).xyz.sub(pickOrigin),
      depth = delta.dot(pickDirection);
    const radius = max(
      float(prepared.boundingRadius),
      depth.div(pixelsPerRadian).mul(pickPixels),
    );
    const miss = delta.sub(pickDirection.mul(depth)).length();
    return select(
      depth
        .greaterThan(0)
        .and(depth.lessThan(pickLimit))
        .and(miss.lessThanEqual(radius)),
      asUint(depth),
      uint(0xffffffff),
    );
  });
  const nearestPick = Fn(() => {
    const candidate = pickCandidate();
    If(candidate.lessThan(uint(0xffffffff)), () => {
      atomicMin(pickState.element(uint(0)), candidate);
    });
  })().compute(capacity);
  const resolvePick = Fn(() => {
    const candidate = pickCandidate();
    If(
      candidate
        .lessThan(uint(0xffffffff))
        .and(candidate.equal(atomicLoad(pickState.element(uint(0))))),
      () => {
        atomicMin(pickState.element(uint(1)), instanceIndex);
      },
    );
  })().compute(capacity);
  const meshes: Mesh[] = [];
  geometries.forEach((g, bucket) => {
    let material: MeshStandardNodeMaterial | MeshBasicNodeMaterial;
    if (bucket < layout.marker) {
      const place = Fn(() => {
        const id = idsRead.element(uint(layout.offsets[bucket]).add(instanceIndex));
        const pose = poseRead.element(id.mul(2)),
          q = poseRead.element(id.mul(2).add(1));
        const rotor = attribute("rotor", "vec4");
        const angle = timeSeconds
            .mul(94)
            .add(float(id.mod(uint(101))))
            .mul(rotor.w),
          c = cos(angle),
          s = sin(angle);
        const delta = positionLocal.sub(rotor.xyz);
        const local = vec3(
          c.mul(delta.x).add(s.mul(delta.z)),
          delta.y,
          c.mul(delta.z).sub(s.mul(delta.x)),
        ).add(rotor.xyz);
        const normal = vec3(
          c.mul(normalLocal.x).add(s.mul(normalLocal.z)),
          normalLocal.y,
          c.mul(normalLocal.z).sub(s.mul(normalLocal.x)),
        );
        positionLocal.assign(rotateQuaternion(q, local).add(pose.xyz));
        normalLocal.assign(rotateQuaternion(q, normal));
      }, "void");
      material = new DroneMaterial(place, bucket);
      material.vertexColors = false;
      const selected = varying(
        idsRead.element(uint(layout.offsets[bucket]).add(instanceIndex)),
      ).equal(selectedId);
      material.colorNode = select(
        selected,
        vec3(1, 0.015, 0.01),
        attribute("color", "vec3"),
      );
    } else {
      material = new MeshBasicNodeMaterial({ color: 0x243f50 });
      const markerId = varying(idsRead.element(uint(layout.offsets[layout.marker]).add(instanceIndex)));
      const type = markerId.mod(uint(DRONE_TYPE_COUNT));
      material.colorNode = select(
        markerId.equal(
          selectedId,
        ),
        vec3(1, 0.015, 0.01),
        select(type.equal(uint(0)), vec3(markerColor.r, markerColor.g, markerColor.b), select(type.equal(uint(1)), vec3(0.45, 0.19, 0.025), vec3(0.03, 0.27, 0.28))),
      );
      material.positionNode = Fn(() => {
        const id = idsRead.element(uint(layout.offsets[layout.marker]).add(instanceIndex)),
          p = poseRead.element(id.mul(2)).xyz;
        const size = length(cameraPosition.sub(p))
          .div(pixelsPerRadian)
          .mul(1.4);
        return p
          .add(cameraRight.mul(positionLocal.x.mul(size)))
          .add(cameraUp.mul(positionLocal.y.mul(size)));
      })();
      material.side = 2;
    }
    g.setIndirect(argsAttribute, bucket * 20);
    const mesh = new Mesh(g, material);
    mesh.frustumCulled = false;
    mesh.name = `drones-lod-${bucket}`;
    scene.add(mesh);
    meshes.push(mesh);
  });
  const matrix = new Matrix4(),
    frustum = new Frustum();
  let disposed = false;
  return {
    capacity,
    models: assets.map((asset, type) => ({ ...DRONE_TYPES[type], sourceSha256: asset.sourceSha256, boundingRadius: asset.boundingRadius })),
    stats: statsAttribute,
    poses: poses.value,
    setPoseOverride(value: ({ id: number } & FlightPose) | null) {
      if (disposed) return;
      if (value === null) { manualId.value = 0xffffffff; return; }
      if (!Number.isInteger(value.id) || value.id < 0 || value.id >= capacity ||
          ![...value.position, ...value.quaternion].every(Number.isFinite) ||
          Math.hypot(...value.quaternion) < 1e-8)
        throw new Error("Invalid drone pose override");
      manualId.value = value.id;
      manualPosition.value.set(...value.position);
      manualQuaternion.value.set(...value.quaternion).normalize();
    },
    select(id: number) {
      if (Number.isInteger(id) && id >= 0 && id < capacity)
        selectedId.value = id;
    },
    async pick(
      origin: Vector3,
      direction: Vector3,
      maxDistance = 180000,
      tolerancePixels = 4,
    ) {
      if (disposed) return null;
      pickOrigin.value.copy(origin);
      pickDirection.value.copy(direction).normalize();
      pickLimit.value = maxDistance;
      pickPixels.value = tolerancePixels;
      renderer.compute([resetPick, nearestPick, resolvePick]);
      const result = new Uint32Array(
        (await renderer.getArrayBufferAsync(pickState.value)) as ArrayBuffer,
      );
      return result[1] < capacity ? result[1] : null;
    },
    passes: [integrate, classify, writeArgs],
    populationBytes:
      words.byteLength +
      table.samples.byteLength +
      table.metadata.byteLength +
      capacity * (32 + 4) + layout.size * 4 +
      5 * 4 * 2 +
      geometries.length * 5 * 4 + DRONE_TYPE_COUNT * 2 * 4 +
      8,
    async auditDraws(allVisible = false) {
      const [ids, argumentsBuffer] = await Promise.all([
        renderer.getArrayBufferAsync(visible.value), renderer.getArrayBufferAsync(argsAttribute),
      ]);
      return auditDroneDraws(capacity, new Uint32Array(ids), new Uint32Array(argumentsBuffer), allVisible);
    },
    update(
      camera: PerspectiveCamera,
      height: number,
      milliseconds: number,
      forceAll = false,
    ) {
      if (disposed) return;
      timeMs.value = Math.floor(milliseconds) >>> 0;
      timeSeconds.value = milliseconds / 1000;
      camera.updateMatrixWorld();
      matrix.multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse,
      );
      frustum.setFromProjectionMatrix(matrix, camera.coordinateSystem);
      frustum.planes.forEach((p, i) =>
        planeValues[i].set(p.normal.x, p.normal.y, p.normal.z, p.constant),
      );
      cameraPosition.value.copy(camera.position);
      cameraRight.value.setFromMatrixColumn(camera.matrixWorld, 0);
      cameraUp.value.setFromMatrixColumn(camera.matrixWorld, 1);
      pixelsPerRadian.value =
        height / (2 * Math.tan((camera.fov * Math.PI) / 360));
      culling.value = forceAll ? 0 : 1;
      renderer.compute([integrate, classify, writeArgs]);
    },
    async counts() {
      return new Uint32Array(
        (await renderer.getArrayBufferAsync(statsAttribute)) as ArrayBuffer,
      );
    },
    async readPoses(count: number) {
      return new Float32Array(
        (await renderer.getArrayBufferAsync(
          poses.value,
          null,
          0,
          Math.min(count, capacity) * 32,
        )) as ArrayBuffer,
      );
    },
    dispose() {
      disposed = true;
      for (const mesh of meshes) {
        scene.remove(mesh);
        mesh.geometry.setIndirect(null);
        mesh.geometry.dispose();
        (mesh.material as MeshStandardNodeMaterial).dispose();
      }
      for (const pass of [
        integrate,
        classify,
        writeArgs,
        resetPick,
        nearestPick,
        resolvePick,
      ])
        pass.dispose();
      releaseStorage(renderer, [
        records.value,
        samples.value,
        metadata.value,
        poses.value,
        state.value,
        visible.value,
        drawCounters.value,
        counters.value,
        argsAttribute,
        statsAttribute,
        pickState.value,
      ]);
    },
  };
}
