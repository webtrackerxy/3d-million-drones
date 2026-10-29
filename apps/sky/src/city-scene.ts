import * as THREE from "three/webgpu";
import type { RoadData } from "../../../packages/city/src/index.ts";
import type { CityData } from "../../../packages/city/src/index.ts";

// One static mesh per occupied tile. No per-building scene object or frame work.
export function createCityScene(data: CityData, roads: RoadData) {
  const group = new THREE.Group();
  group.name = "Canary Wharf / OSM buildings";
  const tiles = new Map<string, typeof data.buildings>();
  for (const building of data.buildings) {
    const list = tiles.get(building.tile) ?? [];
    list.push(building);
    tiles.set(building.tile, list);
  }
  let triangles = 0;
  for (const buildings of tiles.values()) {
    const positions: number[] = [],
      colors: number[] = [];
    const emit = (points: number[][], shade: THREE.Color) => {
      for (const p of points) {
        positions.push(...p);
        colors.push(shade.r, shade.g, shade.b);
      }
    };
    for (const b of buildings) {
      const ring = b.ring.map(([x, z]) => new THREE.Vector2(x, z));
      const shade = new THREE.Color(
        b.flags & 16 ? "#9fa99a" : b.top > 100 ? "#6e8c95" : "#8e9f95",
      );
      const roof = shade.clone().multiplyScalar(1.2);
      for (const [a, c, d] of THREE.ShapeUtils.triangulateShape(ring, []))
        emit(
          [a, c, d].map((i) => [ring[i].x, b.top, ring[i].y]),
          roof,
        );
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i],
          c = ring[(i + 1) % ring.length];
        emit(
          [
            [a.x, b.base, a.y],
            [c.x, b.base, c.y],
            [a.x, b.top, a.y],
            [c.x, b.base, c.y],
            [c.x, b.top, c.y],
            [a.x, b.top, a.y],
          ],
          shade,
        );
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    triangles += positions.length / 9;
    group.add(
      new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({
          vertexColors: true,
          roughness: 0.85,
          metalness: 0.05,
          side: THREE.DoubleSide,
        }),
      ),
    );
  }
  const roadPositions: number[] = [];
  const seen = new Set<string>();
  for (const [from, to, roadClass] of roads.edges) {
    const key = from < to ? `${from},${to}` : `${to},${from}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const a = roads.nodes[from],
      b = roads.nodes[to],
      dx = b[0] - a[0],
      dz = b[1] - a[1],
      length = Math.hypot(dx, dz);
    if (length < 0.1) continue;
    const width = roadClass < 8 ? 4.5 : 3;
    const x = (-dz / length) * width,
      z = (dx / length) * width;
    const p = [a[0] + x, 0.025, a[1] + z],
      q = [a[0] - x, 0.025, a[1] - z],
      r = [b[0] + x, 0.025, b[1] + z],
      t = [b[0] - x, 0.025, b[1] - z];
    roadPositions.push(...p, ...q, ...r, ...q, ...t, ...r);
  }
  const roadGeometry = new THREE.BufferGeometry();
  roadGeometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(roadPositions, 3),
  );
  group.add(
    new THREE.Mesh(
      roadGeometry,
      new THREE.MeshBasicMaterial({ color: "#9baaa3", side: THREE.DoubleSide }),
    ),
  );
  return {
    group,
    tiles: tiles.size,
    triangles,
    roadTriangles: roadPositions.length / 9,
  };
}
