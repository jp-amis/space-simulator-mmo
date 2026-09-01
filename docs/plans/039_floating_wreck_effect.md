# 039 — Floating Wreck / Debris Effect (client)

- **Status:** Done
- **Design step:** Resource epic — client polish
- **Design refs:** [033](033_logistics_warfare_cargo_and_salvage.md) (debris/salvage); [028](028_client_visual_polish.md)
- **Depends on:** [033](033_logistics_warfare_cargo_and_salvage.md)

## Problem
Dropped wrecks (`snap.debris`) render as a **static ♢ diamond** on the `planetLayer`
(`apps/client/src/scene.ts`) — they look inert. They should **gently float/drift** so they read as
loose salvage tumbling in space.

## Approach (client only)
- In the debris draw loop (`scene.ts`), apply a small **time-based bob/rotation** per wreck, reusing
  the existing helpers `phaseOf(id)` and `miningFloat(id, now)` (already in `scene.ts` for the mining
  float): offset the diamond by a small `miningFloat`-style oscillation and/or slowly rotate the
  diamond points by a per-id phase so each wreck drifts independently. Purely cosmetic; no server or
  protocol change.
- Keep the selection halo and hit-testing on the wreck's authoritative `position` (the float is a
  visual-only offset), so clicking to salvage still targets correctly.

## Key files
- `apps/client/src/scene.ts` — debris/wreck draw loop; reuse `phaseOf`/`miningFloat`.

## Acceptance criteria
- Wrecks visibly drift/bob (each with its own phase) instead of sitting perfectly still; the effect
  is subtle and doesn't move the actual pick target.

## Testing
- Manual: destroy a ship, watch the ♢ wreck float; confirm clicking it (with a fleet selected) still
  issues salvage.
- (Optional) a small store/scene unit check that the float offset is bounded (small amplitude).

## Unresolved questions
- Amplitude/speed of the bob and whether to add a slow spin to the diamond (both cheap; tune in play).
