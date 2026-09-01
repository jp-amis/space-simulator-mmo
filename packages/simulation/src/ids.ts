// Prefixed IDs. A seedable counter keeps worldgen deterministic; runtime IDs use
// a module counter + optional random suffix for uniqueness across restarts.

let counter = 0;

export function makeId(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter.toString(36)}${Math.floor(performance.now() % 1e6).toString(36)}`;
}

/** Deterministic ID factory (for worldgen / tests) driven by an incrementing index. */
export function deterministicId(prefix: string, index: number): string {
  return `${prefix}_${index.toString(36).padStart(4, "0")}`;
}
