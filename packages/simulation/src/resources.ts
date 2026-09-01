// Physical-commodity bag helpers (plan 029 §1, 030). Bags are partial records keyed by
// ResourceType; an absent key means 0. Pure + deterministic.

import type { ResourceBag, ResourceType } from "./types.js";
import { RESOURCE_TYPES } from "./types.js";

export function bagTotal(bag: ResourceBag): number {
  let n = 0;
  for (const t of RESOURCE_TYPES) n += bag[t] ?? 0;
  return n;
}

export function cloneBag(bag: ResourceBag): ResourceBag {
  const out: ResourceBag = {};
  for (const t of RESOURCE_TYPES) if (bag[t]) out[t] = bag[t];
  return out;
}

/** Add `amount` of `resource` into `bag` (mutates), never below 0. */
export function addToBag(bag: ResourceBag, resource: ResourceType, amount: number): void {
  bag[resource] = Math.max(0, (bag[resource] ?? 0) + amount);
}

/** Move up to `amount` of `resource` from `src` to `dst`, bounded by `src` stock and
 *  `capacityLeft` (Infinity = unbounded). Returns the amount actually moved. */
export function transfer(
  src: ResourceBag,
  dst: ResourceBag,
  resource: ResourceType,
  amount: number,
  capacityLeft = Infinity,
): number {
  const have = src[resource] ?? 0;
  const moved = Math.max(0, Math.min(amount, have, capacityLeft));
  if (moved <= 0) return 0;
  src[resource] = have - moved;
  dst[resource] = (dst[resource] ?? 0) + moved;
  return moved;
}
