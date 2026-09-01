import { describe, expect, it } from "vitest";
import { MinHeap } from "./heap.js";

describe("MinHeap scheduler (DESIGN §5.2)", () => {
  it("pops in ascending key order", () => {
    const h = new MinHeap<number>((x) => x);
    [5, 1, 9, 3, 7, 2].forEach((n) => h.push(n));
    const out: number[] = [];
    while (h.size) out.push(h.pop()!);
    expect(out).toEqual([1, 2, 3, 5, 7, 9]);
  });

  it("popDue returns all events due at/before a timestamp, ordered", () => {
    const h = new MinHeap<{ atMs: number; id: string }>((e) => e.atMs);
    h.push({ atMs: 300, id: "c" });
    h.push({ atMs: 100, id: "a" });
    h.push({ atMs: 200, id: "b" });
    h.push({ atMs: 500, id: "d" });
    const due = h.popDue(250);
    expect(due.map((e) => e.id)).toEqual(["a", "b"]);
    expect(h.size).toBe(2);
  });

  it("handles multiple due events in one heartbeat", () => {
    const h = new MinHeap<number>((x) => x);
    [100, 100, 100, 400].forEach((n) => h.push(n));
    expect(h.popDue(100)).toHaveLength(3);
  });
});
