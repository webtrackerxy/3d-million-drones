export function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mean =
    values.reduce((sum, x) => sum + x, 0) / Math.max(1, values.length);
  return {
    samples: values.length,
    meanMs: mean,
    p50Ms: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
    p95Ms:
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ??
      0,
    fps: mean > 0 ? 1000 / mean : 0,
  };
}
