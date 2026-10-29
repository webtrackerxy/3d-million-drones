export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
export const RECORD_WORDS = 8;
export const SAMPLE_FLOATS = 12;
export const META_WORDS = 8;
// Descriptor word 7 flags. Existing route descriptors leave this word zero.
export const WORLD_XZ_OFFSETS = 1;
export const SCHEDULED_START = 2;
export const TAU = Math.PI * 2;
export function hash32(value: number): number {
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return (value ^ (value >>> 16)) >>> 0;
}
