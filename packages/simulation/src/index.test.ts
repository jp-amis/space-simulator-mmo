import { describe, expect, it } from "vitest";
import { length, sub } from "./index.js";

describe("vec2 math", () => {
  it("subtracts componentwise", () => {
    expect(sub({ x: 3, y: 5 }, { x: 1, y: 2 })).toEqual({ x: 2, y: 3 });
  });

  it("computes length", () => {
    expect(length({ x: 3, y: 4 })).toBe(5);
  });
});
