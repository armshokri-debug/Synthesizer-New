/** Studio custom tuning is a value owned by a track, never the standalone cache. */
export const STUDIO_TUNING_KEY = "studioCustomTuning";
export function normalizeStudioTuning(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length !== 12 || !value.every(x => typeof x === "number" && Number.isFinite(x))) return undefined;
  return value.map(x => Math.round(Math.max(-100, Math.min(100, x)) * 10) / 10);
}
