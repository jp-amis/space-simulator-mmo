// Pure movement/combat/domain logic. Keep functions pure so they run in tests,
// command handlers and (later) worker threads (docs/DESIGN.md §16 rules 2 & 6).

export * from "./types.js";
export * from "./vec.js";
export * from "./rng.js";
export * from "./heap.js";
export * from "./ids.js";
export * from "./movement.js";
export * from "./spatialHash.js";
export * from "./ship.js";
export * from "./fleet.js";
export * from "./worldgen.js";
export * from "./economy.js";
export * from "./resources.js";
export * from "./combat.js";
export * from "./worldSim.js";
export * from "./operations.js";
