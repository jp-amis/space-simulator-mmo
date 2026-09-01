// Deterministic RNG abstraction (DESIGN §7.3, §16 rule 6). Never Math.random() in sim.
// mulberry32 — fast, seedable, reproducible. State is a plain 32-bit integer so it
// serializes cleanly into BattleState.rngState.

export interface Rng {
  state: number;
  next(): number; // [0,1)
  int(maxExclusive: number): number;
  range(min: number, max: number): number;
  pick<T>(arr: readonly T[]): T;
}

export function mulberry32(seed: number): Rng {
  const rng: Rng = {
    state: seed >>> 0,
    next() {
      this.state = (this.state + 0x6d2b79f5) >>> 0;
      let t = this.state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    int(maxExclusive: number) {
      return Math.floor(this.next() * maxExclusive);
    },
    range(min: number, max: number) {
      return min + this.next() * (max - min);
    },
    pick<T>(arr: readonly T[]): T {
      if (arr.length === 0) throw new Error("pick from empty array");
      return arr[this.int(arr.length)]!;
    },
  };
  return rng;
}

/** Re-hydrate an RNG from a stored 32-bit state (for battle replay). */
export function rngFromState(state: number): Rng {
  const r = mulberry32(0);
  r.state = state >>> 0;
  return r;
}
