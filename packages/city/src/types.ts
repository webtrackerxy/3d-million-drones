export interface Building {
  osmId: string;
  tile: string;
  base: number;
  top: number;
  flags: number;
  ring: number[][];
}
export interface CityData {
  schemaVersion: number;
  region: string;
  buildings: Building[];
}
export interface CityManifest {
  schemaVersion: number;
  region: string;
  origin: { crs: string; easting: number; northing: number };
  buildings: number;
  maxRoofM: number;
  localBoundsM: { minX: number; maxX: number; minZ: number; maxZ: number };
  data: { sha256: string; bytes: number };
  verticalDatum: string;
}
