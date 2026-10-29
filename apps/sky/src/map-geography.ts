import proj4 from "proj4";
import { Matrix4, Vector3 } from "three";
import type { Vec3 } from "../../../packages/core-types/src/index.ts";

export interface MapReference {
  origin: { easting: number; northing: number };
  projection: { definition: string };
}
export function createMapGeography(reference: MapReference) {
  const converter = proj4("EPSG:4326", reference.projection.definition);
  const geographic = ([x, height, z]: Vec3) => {
    const [longitude, latitude] = converter.inverse([
      reference.origin.easting + x,
      reference.origin.northing - z,
    ]);
    return { latitude, longitude, height };
  };
  return {
    geographic,
    // Tangent rendering frame: preserves BNG grid convergence, with uniform scale.
    // This is not a nonlinear terrain reprojection or surveyed height alignment.
    ecefFrame(groundHeightM = 45) {
      if (
        !Number.isFinite(groundHeightM) ||
        groundHeightM < -100 ||
        groundHeightM > 500
      )
        throw new Error("Ground alignment must be between -100 and 500 metres");
      const centre = geographic([0, 0, 0]),
        eastPoint = geographic([1, 0, 0]);
      const origin = wgs84ToEcef(
        centre.latitude,
        centre.longitude,
        groundHeightM,
      );
      const eastStep = wgs84ToEcef(
        eastPoint.latitude,
        eastPoint.longitude,
        groundHeightM,
      ).sub(origin);
      const lat = (centre.latitude * Math.PI) / 180,
        lon = (centre.longitude * Math.PI) / 180;
      const up = new Vector3(
        Math.cos(lat) * Math.cos(lon),
        Math.cos(lat) * Math.sin(lon),
        Math.sin(lat),
      );
      const scale = eastStep.length(),
        east = eastStep.addScaledVector(up, -eastStep.dot(up)).normalize(),
        south = new Vector3().crossVectors(east, up).normalize();
      const localToEcef = new Matrix4()
        .makeBasis(
          east.multiplyScalar(scale),
          up.multiplyScalar(scale),
          south.multiplyScalar(scale),
        )
        .setPosition(origin);
      return { localToEcef, ecefToLocal: localToEcef.clone().invert(), origin };
    },
  };
}
export function wgs84ToEcef(
  latitude: number,
  longitude: number,
  height: number,
) {
  const lat = (latitude * Math.PI) / 180,
    lon = (longitude * Math.PI) / 180,
    a = 6378137,
    e2 = 6.6943799901413165e-3;
  const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  return new Vector3(
    (n + height) * Math.cos(lat) * Math.cos(lon),
    (n + height) * Math.cos(lat) * Math.sin(lon),
    (n * (1 - e2) + height) * Math.sin(lat),
  );
}
export function formatDronePosition(
  position: Vec3,
  geography?: ReturnType<typeof createMapGeography>,
) {
  if (geography) {
    const p = geography.geographic(position);
    return `Lat ${p.latitude.toFixed(5)} · Lng ${p.longitude.toFixed(5)}`;
  }
  return `X ${position[0].toFixed(1)} m · Z ${position[2].toFixed(1)} m`;
}
