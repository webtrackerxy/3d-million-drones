import * as THREE from "three/webgpu";
import { planLondonTiles } from "../../../packages/city/src/london.ts";
import type { LondonManifest } from "../../../packages/city/src/london.ts";
import type { LaunchSite } from "../../../packages/city/src/fleet.ts";
type Rings = number[][][];
type Building = [string, number, number, number, Rings];
interface TileData {
  key: string;
  x: number;
  z: number;
  b: Building[];
  r: [number, number[][], string][];
  a: [string, Rings][];
}
export interface LondonOverview {
  areas: [string, Rings][];
  roads: [number, number[], number[]][];
  places: { name: string; kind: string; x: number; z: number }[];
  landmarks: { key: string; x: number; z: number; b: Building[] }[];
}

function polygon(rings: Rings) {
  return rings.map((r) => {
    const points = r.map(([x, z]) => new THREE.Vector2(x, z));
    if (points.length > 1 && points[0].equals(points.at(-1)!)) points.pop();
    return points;
  });
}
function positionGeometry(positions: number[], colors?: number[]) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  if (colors)
    g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  g.computeBoundingSphere();
  return g;
}
export function createLondonScene(
  manifest: LondonManifest,
  overview: LondonOverview,
  onStatus: (text: string) => void,
  sites: LaunchSite[] = [],
) {
  const group = new THREE.Group(),
    base = new THREE.Group(),
    coarse = new THREE.Group(),
    detail = new THREE.Group(),
    labels = new THREE.Group();
  group.name = "Greater London · streamed OSM city";
  group.add(base, coarse, detail, labels);
  const padMaterial = new THREE.MeshBasicMaterial({
    color: "#5dada7",
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.65,
    depthWrite: false,
  });
  for (const site of sites) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(site.radiusM - 1.5, site.radiusM, 64),
      padMaterial,
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(
      site.position[0],
      site.surfaceHeightM + 0.06,
      site.position[2],
    );
    group.add(ring);
    const mark = new THREE.Mesh(new THREE.PlaneGeometry(12, 2), padMaterial);
    mark.rotation.x = -Math.PI / 2;
    mark.position.set(
      site.position[0],
      site.surfaceHeightM + 0.07,
      site.position[2],
    );
    group.add(mark);
  }
  const buildingMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.9,
    metalness: 0.03,
    side: THREE.DoubleSide,
  });
  const areaMaterials = {
    water: new THREE.MeshBasicMaterial({
      color: "#6e9fad",
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
    green: new THREE.MeshBasicMaterial({
      color: "#9bb686",
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  };
  const roadMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  function buildings(data: Building[], x: number, z: number) {
    const positions: number[] = [],
      colors: number[] = [];
    const emit = (points: number[][], color: THREE.Color) => {
      for (const p of points) {
        positions.push(...p);
        colors.push(color.r, color.g, color.b);
      }
    };
    for (const [, bottom, top, flags, rings] of data) {
      const contours = polygon(rings);
      if (!contours[0] || contours[0].length < 3) continue;
      const shade = new THREE.Color(
          flags & 16 ? "#a1aaa0" : top > 100 ? "#718e99" : "#929f9f",
        ),
        roof = shade.clone().multiplyScalar(1.18);
      const flat = contours.flat();
      for (const triangle of THREE.ShapeUtils.triangulateShape(
        contours[0],
        contours.slice(1),
      ))
        emit(
          triangle.map((i) => [flat[i].x, top, flat[i].y]),
          roof,
        );
      for (const ring of contours)
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i],
            b = ring[(i + 1) % ring.length];
          emit(
            [
              [a.x, bottom, a.y],
              [b.x, bottom, b.y],
              [a.x, top, a.y],
              [b.x, bottom, b.y],
              [b.x, top, b.y],
              [a.x, top, a.y],
            ],
            shade,
          );
        }
    }
    const geometry = positionGeometry(positions, colors);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, buildingMaterial);
    mesh.position.set(x * 1024, 0, z * 1024);
    return mesh;
  }
  function areas(entries: [string, Rings][], x: number, z: number) {
    const result = new THREE.Group();
    for (const kind of ["green", "water"] as const) {
      const positions: number[] = [];
      for (const [type, rings] of entries) {
        if (type !== kind) continue;
        const contours = polygon(rings);
        if (!contours[0] || contours[0].length < 3) continue;
        const flat = contours.flat();
        for (const triangle of THREE.ShapeUtils.triangulateShape(
          contours[0],
          contours.slice(1),
        ))
          for (const i of triangle)
            positions.push(
              flat[i].x,
              kind === "water" ? 0.04 : 0.01,
              flat[i].y,
            );
      }
      if (positions.length) {
        const mesh = new THREE.Mesh(
          positionGeometry(positions),
          areaMaterials[kind],
        );
        mesh.position.set(x * 1024, 0, z * 1024);
        mesh.renderOrder = kind === "water" ? -94 : -95;
        result.add(mesh);
      }
    }
    return result;
  }
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(85000, 80000),
    new THREE.MeshBasicMaterial({ color: "#e9e9df", depthWrite: false }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(
    (manifest.bounds.minX + manifest.bounds.maxX) / 2,
    -0.2,
    (manifest.bounds.minZ + manifest.bounds.maxZ) / 2,
  );
  ground.renderOrder = -100;
  base.add(ground);
  base.add(areas(overview.areas, 0, 0));
  const major: number[] = [];
  for (const [, a, b] of overview.roads)
    major.push(a[0], 0.12, a[1], b[0], 0.12, b[1]);
  const majorLines = new THREE.LineSegments(
    positionGeometry(major),
    new THREE.LineBasicMaterial({ color: "#9d927b", depthWrite: false }),
  );
  majorLines.renderOrder = -90;
  base.add(majorLines);
  const coarseTiles = new Map<string, THREE.Mesh>();
  for (const tile of overview.landmarks) {
    const mesh = buildings(tile.b, tile.x, tile.z);
    coarseTiles.set(tile.key, mesh);
    coarse.add(mesh);
  }
  const primary = overview.places
    .filter(
      (p) =>
        p.kind !== "suburb" ||
        /Westminster|Canary Wharf|Stratford|Greenwich|Camden|Woolwich|Barking|Bexley|Dagenham|Hammersmith|Hackney|Tottenham|Lewisham|Richmond|Kingston|Sutton|Bromley|Croydon|Ealing|Harrow|Enfield|Romford|Uxbridge|Ilford|Wembley|Hounslow|Barnet|Orpington/.test(
          p.name,
        ),
    )
    .slice(0, 100);
  const sprites: THREE.Sprite[] = [];
  const roadSprites = new Set<THREE.Sprite>();
  for (const place of primary) {
    const canvas = document.createElement("canvas");
    canvas.width = 384;
    canvas.height = 72;
    const context = canvas.getContext("2d")!;
    context.textAlign = "center";
    context.font = "700 30px sans-serif";
    context.lineWidth = 7;
    context.lineJoin = "round";
    context.strokeStyle = "#ffffff";
    context.strokeText(place.name, 192, 46);
    context.fillStyle = "#172a33";
    context.fillText(place.name, 192, 46);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        fog: false,
      }),
    );
    sprite.position.set(place.x, 25, place.z);
    sprite.renderOrder = 10;
    labels.add(sprite);
    sprites.push(sprite);
  }
  const catalog = new Map(manifest.tiles.map((t) => [t.key, t]));
  const resident = new Map<
      string,
      { group: THREE.Group; b: THREE.Mesh; base: THREE.Group }
    >(),
    pending = new Set<string>(),
    failures = new Set<string>();
  let wanted = new Set<string>(),
    active = false,
    paused = false,
    showBuildings = true,
    showBase = true,
    lastPlan = 0;
  const urlRoot = new URL("./london/", location.href);
  function dispose(key: string) {
    const tile = resident.get(key);
    if (!tile) return;
    tile.group.removeFromParent();
    tile.group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      const sprite = object as THREE.Sprite;
      if (sprite.isSprite) {
        roadSprites.delete(sprite);
        sprite.material.map?.dispose();
        sprite.material.dispose();
      } else if (mesh.geometry) mesh.geometry.dispose();
    });
    resident.delete(key);
    const proxy = coarseTiles.get(key);
    if (proxy) proxy.visible = showBuildings;
  }
  function status() {
    onStatus(
      `${resident.size} detailed city tiles${pending.size ? " · loading" : ""}${failures.size ? " · some detail unavailable" : ""}`,
    );
  }
  const callbacks = new Map<string, (data: TileData) => void>();
  Object.assign(globalThis, {
    __londonTileLoaded: (key: string, data: TileData) =>
      callbacks.get(key)?.(data),
  });
  function pump() {
    if (paused) return;
    for (const key of wanted) {
      if (pending.size >= 4) break;
      if (resident.has(key) || pending.has(key) || failures.has(key)) continue;
      const tile = catalog.get(key);
      if (!tile) continue;
      pending.add(key);
      const script = document.createElement("script");
      script.src = new URL(tile.file, urlRoot).href;
      callbacks.set(key, (data) => {
        if (data.key !== key) return;
        if (active && !paused && wanted.has(key)) {
          const tileGroup = new THREE.Group(),
            b = buildings(data.b, data.x, data.z),
            tileBase = areas(data.a, data.x, data.z),
            positions: number[] = [],
            colors: number[] = [];
          const names = new Map<
            string,
            { length: number; x: number; z: number }
          >();
          for (const [roadClass, points, name] of data.r) {
            const [a, c] = points,
              dx = c[0] - a[0],
              dz = c[1] - a[1],
              length = Math.hypot(dx, dz);
            if (length < 0.1) continue;
            if (
              name &&
              roadClass < 14 &&
              length > 50 &&
              (!names.has(name) || names.get(name)!.length < length)
            )
              names.set(name, {
                length,
                x: (a[0] + c[0]) / 2 + data.x * 1024,
                z: (a[1] + c[1]) / 2 + data.z * 1024,
              });
            const width = roadClass < 8 ? 4 : roadClass < 14 ? 2.7 : 0.9,
              x = (-dz / length) * width,
              z = (dx / length) * width;
            const p = [a[0] + x, 0.13, a[1] + z],
              q = [a[0] - x, 0.13, a[1] - z],
              r = [c[0] + x, 0.13, c[1] + z],
              s = [c[0] - x, 0.13, c[1] - z],
              color = new THREE.Color(
                roadClass < 4
                  ? "#e8cf9e"
                  : roadClass < 9
                    ? "#f2e6c4"
                    : roadClass < 14
                      ? "#f5f3e9"
                      : "#cbd1bf",
              );
            for (const v of [p, q, r, q, s, r]) {
              positions.push(...v);
              colors.push(color.r, color.g, color.b);
            }
          }
          if (positions.length) {
            const road = new THREE.Mesh(
              positionGeometry(positions, colors),
              roadMaterial,
            );
            road.position.set(data.x * 1024, 0, data.z * 1024);
            road.renderOrder = -89;
            tileBase.add(road);
          }
          for (const [name, point] of [...names]
            .sort((a, b) => b[1].length - a[1].length)
            .slice(0, 4)) {
            const canvas = document.createElement("canvas");
            canvas.width = 384;
            canvas.height = 72;
            const context = canvas.getContext("2d")!;
            context.font = "700 28px sans-serif";
            context.textAlign = "center";
            context.lineWidth = 7;
            context.lineJoin = "round";
            context.strokeStyle = "#ffffff";
            context.strokeText(name, 192, 46);
            context.fillStyle = "#172a33";
            context.fillText(name, 192, 46);
            const texture = new THREE.CanvasTexture(canvas);
            texture.colorSpace = THREE.SRGBColorSpace;
            const sprite = new THREE.Sprite(
              new THREE.SpriteMaterial({
                map: texture,
                transparent: true,
                depthTest: false,
                depthWrite: false,
                toneMapped: false,
                fog: false,
              }),
            );
            sprite.position.set(point.x, 4, point.z);
            sprite.renderOrder = 9;
            roadSprites.add(sprite);
            tileBase.add(sprite);
          }
          b.visible = showBuildings;
          tileBase.visible = showBase;
          tileGroup.add(b, tileBase);
          detail.add(tileGroup);
          resident.set(key, { group: tileGroup, b, base: tileBase });
          const proxy = coarseTiles.get(key);
          if (proxy) proxy.visible = false;
        }
      });
      script.onload = () => {
        pending.delete(key);
        callbacks.delete(key);
        script.remove();
        status();
        pump();
      };
      script.onerror = () => {
        pending.delete(key);
        callbacks.delete(key);
        failures.add(key);
        script.remove();
        status();
        pump();
      };
      document.head.append(script);
    }
    status();
  }
  function buildingsVisible(value: boolean) {
    showBuildings = value;
    coarse.visible = value;
    for (const [key, mesh] of coarseTiles)
      mesh.visible = value && !resident.has(key);
    for (const tile of resident.values()) tile.b.visible = value;
  }
  function basemapVisible(value: boolean) {
    showBase = value;
    base.visible = value;
    labels.visible = value;
    for (const tile of resident.values()) tile.base.visible = value;
  }
  return {
    group,
    base,
    coarse,
    pickOccluders: () =>
      showBuildings
        ? [...coarseTiles.values()]
            .filter((m) => m.visible)
            .concat([...resident.values()].map((t) => t.b))
        : [],
    buildingsVisible,
    basemapVisible,
    overview,
    setPaused: (value: boolean) => {
      paused = value;
      if (!value) pump();
    },
    statistics: () => ({
      resident: resident.size,
      pending: pending.size,
      failed: failures.size,
      limit: 32,
      total: manifest.tiles.length,
    }),
    update(
      camera: THREE.PerspectiveCamera,
      focus: THREE.Vector3,
      isActive: boolean,
    ) {
      active = isActive;
      group.visible = isActive;
      if (!isActive) {
        wanted.clear();
        for (const key of resident.keys()) dispose(key);
        return;
      }
      const now = performance.now();
      if (now - lastPlan > 350) {
        lastPlan = now;
        wanted = new Set(
          camera.position.y > 9000
            ? []
            : planLondonTiles(
                manifest.tiles,
                [focus.x, camera.position.y, focus.z],
                32,
              ),
        );
        for (const key of resident.keys()) if (!wanted.has(key)) dispose(key);
        pump();
      }
      if (showBase) {
        const occupied = new Set<string>();
        for (const sprite of [...sprites, ...roadSprites]) {
          const distance = camera.position.distanceTo(sprite.position),
            projected = sprite.position.clone().project(camera),
            cell = `${Math.round(projected.x * 8)},${Math.round(projected.y * 7)}`;
          sprite.visible =
            projected.z < 1 &&
            Math.abs(projected.x) < 1.1 &&
            Math.abs(projected.y) < 1.1 &&
            distance > 100 &&
            !occupied.has(cell);
          if (roadSprites.has(sprite))
            sprite.visible =
              showBase &&
              sprite.visible &&
              camera.position.y < 2000 &&
              distance < 6000;
          if (sprite.visible) occupied.add(cell);
          // Keep text readable at close and overview zoom without lighting/fog washout.
          const unitsPerPixel =
            (2 * distance * Math.tan((camera.fov * Math.PI) / 360)) /
            Math.max(1, innerHeight);
          const scale = unitsPerPixel * (roadSprites.has(sprite) ? 180 : 190);
          sprite.scale.set(scale, (scale * 72) / 384, 1);
        }
      }
    },
  };
}
