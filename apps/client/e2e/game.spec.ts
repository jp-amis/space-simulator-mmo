import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

const SHOTS = "e2e/__screenshots__";
mkdirSync(SHOTS, { recursive: true });

/* eslint-disable @typescript-eslint/no-explicit-any */
async function game(page: Page): Promise<any> {
  return page.evaluate(() => (window as any).__game);
}

async function connect(page: Page, id: string): Promise<void> {
  await page.goto("/");
  await expect(page.locator("#id-overlay")).toBeVisible();
  await page.fill("#player-id", id);
  await page.click("#connect-btn");
  await expect(page.locator("#resource-bar")).toBeVisible();
  // Wait until the first authoritative snapshot has been applied.
  await expect
    .poll(async () => page.evaluate(() => (window as any).__game?.store?.snapshot?.planets?.length ?? 0), {
      timeout: 10_000,
    })
    .toBeGreaterThan(0);
}

/** Screen coords of a world point via the live camera. */
async function screenOf(page: Page, world: { x: number; y: number }): Promise<{ x: number; y: number }> {
  return page.evaluate((w) => (window as any).__game.camera.worldToScreen(w.x, w.y), world);
}

test.describe("plan 003 — strategic map & procedural universe", () => {
  test("shows the ID entry screen", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#id-overlay")).toBeVisible();
    await expect(page.locator("#player-id")).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/01-id-entry.png` });
  });

  test("the in-app player guide opens from the ID screen and loads its screenshots", async ({ page }) => {
    await page.goto("/");
    await page.click("#guide-link");
    await expect(page.locator("#guide-overlay")).toBeVisible();
    await expect(page.locator("#guide-overlay")).toContainText("Player Guide");
    // Tutorial screenshots resolve (served from /public/guide).
    const imgLoaded = await page
      .locator("#guide-overlay img")
      .first()
      .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0);
    expect(imgLoaded).toBe(true);
    await page.click("#guide-close");
    await expect(page.locator("#guide-overlay")).toBeHidden();
  });

  test("renders a procedural map after connecting", async ({ page }) => {
    await connect(page, "alice");
    await expect(page.locator("canvas")).toBeVisible();
    const planetCount = await page.evaluate(() => (window as any).__game.store.snapshot.planets.length);
    expect(planetCount).toBeGreaterThan(10);
    // Own ships + fleet exist.
    const shipCount = await page.evaluate(() => (window as any).__game.store.snapshot.ships.length);
    expect(shipCount).toBe(2);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/02-map.png` });
    // Zoom in on the fleet: individual ships render in formation around the anchor
    // even outside combat (LOD).
    await page.evaluate(() => {
      const g = (window as any).__game;
      const f = g.store.snapshot.fleets.find((x: any) => x.ownerId === g.store.playerId);
      const p = g.store.fleetPosition(f);
      g.camera.centerOn(p.x, p.y);
      g.camera.zoom = 0.7;
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/10-fleet-ships.png` });
  });

  test("selects the home planet and shows its inspector", async ({ page }) => {
    await connect(page, "alice");
    const home = await page.evaluate(() => {
      const g = (window as any).__game;
      const s = g.store.snapshot;
      return s.planets.find((p: any) => p.id === s.you.homePlanetId);
    });
    const pt = await screenOf(page, home.position);
    await page.mouse.click(pt.x, pt.y);
    await expect(page.locator("#inspector")).toBeVisible();
    await expect(page.locator("#inspector")).toContainText(home.name);
    await page.screenshot({ path: `${SHOTS}/03-planet-selected.png` });
  });
});

test.describe("plan 004 — fleet movement", () => {
  test("selecting a fleet and clicking empty space issues a move", async ({ page }) => {
    await connect(page, "alice");
    // Find own fleet and its screen position.
    const fleet = await page.evaluate(() => {
      const g = (window as any).__game;
      const f = g.store.snapshot.fleets.find((x: any) => x.ownerId === g.store.playerId);
      return { id: f.id, pos: g.store.fleetPosition(f) };
    });
    const fpt = await screenOf(page, fleet.pos);
    await page.mouse.click(fpt.x, fpt.y);
    // Select confirmed.
    expect(await page.evaluate(() => (window as any).__game.store.selectedKind)).toBe("fleet");
    // Click empty space (corner) to move: the anchor jumps to the click and the fleet
    // reports "moving" as its ships fly there.
    await page.mouse.click(60, 400);
    await expect
      .poll(async () => page.evaluate((id) => {
        const g = (window as any).__game;
        return g.store.snapshot.fleets.find((f: any) => f.id === id)?.status;
      }, fleet.id), { timeout: 8000 })
      .toBe("moving");
    // The anchor (goal point) moved away from where the fleet started.
    const anchorMoved = await page.evaluate((f) => {
      const g = (window as any).__game;
      const fl = g.store.snapshot.fleets.find((x: any) => x.id === f.id);
      return Math.hypot(fl.anchor.x - f.pos.x, fl.anchor.y - f.pos.y);
    }, fleet);
    expect(anchorMoved).toBeGreaterThan(100);
    await page.screenshot({ path: `${SHOTS}/04-fleet-move.png` });
  });
});

test.describe("plan 027 — fleet formation presets", () => {
  test("selecting a formation preset updates the fleet", async ({ page }) => {
    await connect(page, "formation1");
    // Select own fleet so the order/formation controls render.
    await page.evaluate(() => {
      const g = (window as any).__game;
      const f = g.store.snapshot.fleets.find((x: any) => x.ownerId === g.store.playerId);
      g.store.selectedId = f.id;
      g.store.selectedKind = "fleet";
    });
    await expect(page.locator("#fleet-formation-shape")).toBeVisible();
    await page.selectOption("#fleet-formation-shape", "wedge");
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const g = (window as any).__game;
          const f = g.store.snapshot.fleets.find((x: any) => x.ownerId === g.store.playerId);
          return f?.formation;
        }),
      )
      .toBe("wedge");
  });
});

test.describe("plan 008 — ship builder", () => {
  test("opens the builder, shows a valid design, and applies", async ({ page }) => {
    await connect(page, "alice");
    // Select own fleet to reveal ship edit buttons.
    const fleet = await page.evaluate(() => {
      const g = (window as any).__game;
      const f = g.store.snapshot.fleets.find((x: any) => x.ownerId === g.store.playerId);
      return { id: f.id, pos: g.store.fleetPosition(f) };
    });
    const fpt = await screenOf(page, fleet.pos);
    await page.mouse.click(fpt.x, fpt.y);
    await page.locator(".fleet-ship-btn").first().click();
    await expect(page.locator("#ship-builder")).toBeVisible();
    await expect(page.locator("#builder-errors")).toContainText("valid design");
    await page.screenshot({ path: `${SHOTS}/05-ship-builder.png` });
    await page.locator("#builder-apply").click();
    await expect(page.locator("#ship-builder")).toBeHidden();
  });
});

test.describe("plans 016-022 — continuous on-map combat", () => {
  test("a hostile spawn triggers combat rendered on the map (no separate battle screen)", async ({ page }) => {
    test.setTimeout(90_000);
    await connect(page, "warrior");

    // Set aggressive doctrine and spawn a hostile fleet right on our fleet.
    const fleet = await page.evaluate(() => {
      const g = (window as any).__game;
      const f = g.store.snapshot.fleets.find((x: any) => x.ownerId === g.store.playerId);
      g.net.command({ type: "setDoctrine", fleetId: f.id, preset: "attack_on_sight" });
      const pos = g.store.fleetPosition(f);
      g.net.command({ type: "spawnHostile", near: pos });
      return { id: f.id, pos };
    });

    // Ships appear in the shared world (activeRegion delta) — no separate battle view.
    await expect
      .poll(() => page.evaluate(() => (window as any).__game.store.activeShips.size), { timeout: 40_000, intervals: [500] })
      .toBeGreaterThan(0);
    // The client renders combat on the map (there is no store.battle anymore).
    expect(await page.evaluate(() => "battle" in (window as any).__game.store)).toBe(false);
    // Own ships lock onto the hostile → inCombat becomes true (may take a few ticks).
    await expect
      .poll(() => page.evaluate(() => (window as any).__game.store.inCombat), { timeout: 40_000, intervals: [500] })
      .toBe(true);

    // #1/#9: the doctrine <select> must stay clickable during combat snapshot-churn
    // (the inspector must not rebuild every frame and detach it).
    await page.evaluate(() => {
      const g = (window as any).__game;
      g.store.selectedId = fleet0Id();
      g.store.selectedKind = "fleet";
      function fleet0Id() {
        return g.store.snapshot.fleets.find((f: any) => f.ownerId === g.store.playerId).id;
      }
    });
    await expect(page.locator("#fleet-doctrine")).toBeVisible();
    await page.selectOption("#fleet-doctrine", "pursue");
    await expect(page.locator("#fleet-doctrine")).toHaveValue("pursue");

    // Zoom in to show ship detail, screenshot the on-map fight.
    await page.evaluate((p) => {
      (window as any).__game.camera.centerOn(p.x, p.y);
      (window as any).__game.camera.zoom = 0.65;
    }, fleet.pos);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${SHOTS}/06-onmap-combat.png` });

    // Combat is decisive: one side is wiped out. Own ships always stream (always-on
    // sim), so we assert the fight resolves to a single surviving owner (or none).
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const g = (window as any).__game;
            const owners = new Set<string>();
            for (const s of g.store.activeShips.values()) if (s.dto.alive) owners.add(s.dto.ownerId);
            return owners.size;
          }),
        { timeout: 60_000, intervals: [1000] },
      )
      .toBeLessThanOrEqual(1);
    await page.screenshot({ path: `${SHOTS}/08-post-combat.png` });
  });
});

async function dockedShipId(page: Page): Promise<string | undefined> {
  return page.evaluate(() => {
    const g = (window as any).__game;
    const s = g.store.snapshot;
    const inFleet = new Set(
      s.fleets.filter((f: any) => f.ownerId === g.store.playerId).flatMap((f: any) => f.shipIds ?? []),
    );
    return s.you.shipIds.find((id: string) => !inFleet.has(id));
  });
}
async function ownFleetCount(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as any).__game.store.snapshot.fleets.filter((f: any) => f.ownerId === (window as any).__game.store.playerId && f.status !== "destroyed").length,
  );
}

test.describe("plan 012 — fleet & ship management", () => {
  test("builds a ship, docks it, forms a fleet, then merges it back", async ({ page }) => {
    test.setTimeout(60_000);
    await connect(page, "roster1"); // isolated id — the shared server persists other tests' state
    // Build a ship straight from the authoritative command (reuses a starter blueprint).
    await page.evaluate(() => {
      const g = (window as any).__game;
      const s = g.store.snapshot;
      const planet = s.planets.find((p: any) => p.id === s.you.homePlanetId);
      const bp = g.store.ship(s.you.shipIds[0]).blueprint;
      g.net.command({ type: "buildShip", planetId: planet.id, blueprint: bp, name: "Built" });
    });
    // Wait for construction to finish (docked ship appears in you.shipIds).
    await expect
      .poll(async () => page.evaluate(() => (window as any).__game.store.snapshot.you.shipIds.length), { timeout: 20_000 })
      .toBe(3);

    await page.click("#roster-toggle");
    await expect(page.locator("#roster")).toBeVisible();
    const docked = await dockedShipId(page);
    expect(docked).toBeTruthy();
    await expect(page.locator(`#roster [data-ship="${docked}"]`)).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/07-roster.png` });

    // Create a fleet from the docked ship → own fleet count goes 1 → 2.
    expect(await ownFleetCount(page)).toBe(1);
    await page.locator(`#roster [data-ship="${docked}"] input.roster-ship-check`).check();
    await page.click("#roster-create-fleet");
    await expect.poll(() => ownFleetCount(page), { timeout: 8000 }).toBe(2);

    // Merge it back: check the ship (now in the new fleet), add it to the original fleet.
    const originalFleet = await page.evaluate(() => {
      const g = (window as any).__game;
      const mine = g.store.snapshot.fleets.filter((f: any) => f.ownerId === g.store.playerId);
      return mine.find((f: any) => f.shipCount === 2)?.id ?? mine[0].id;
    });
    await page.locator(`#roster [data-ship="${docked}"] input.roster-ship-check`).check();
    await page.selectOption("#roster-add-target", originalFleet);
    await page.click("#roster-add-fleet");
    await expect.poll(() => ownFleetCount(page), { timeout: 8000 }).toBe(1);
  });
});

test.describe("plan 014 — navigation & camera", () => {
  test("Home button recenters; fleet locate centers on the fleet", async ({ page }) => {
    await connect(page, "nav1");
    const home = await page.evaluate(() => {
      const g = (window as any).__game;
      const s = g.store.snapshot;
      return s.planets.find((p: any) => p.id === s.you.homePlanetId).position;
    });
    // Pan far away.
    await page.evaluate(() => {
      (window as any).__game.camera.x += 9000;
      (window as any).__game.camera.y += 9000;
    });
    await page.click("#home-btn");
    await page.waitForTimeout(100);
    const cam = await page.evaluate(() => ({ x: (window as any).__game.camera.x, y: (window as any).__game.camera.y }));
    expect(Math.hypot(cam.x - home.x, cam.y - home.y)).toBeLessThan(100);

    // Locate a fleet from the roster centers the camera on it.
    await page.evaluate(() => {
      (window as any).__game.camera.x += 6000;
      (window as any).__game.camera.y -= 6000;
    });
    await page.click("#roster-toggle");
    await expect(page.locator("#roster")).toBeVisible();
    await expect(page.locator(".roster-fleet-locate").first()).toBeVisible();
    await page.locator(".roster-fleet-locate").first().click();
    await page.waitForTimeout(100);
    const after = await page.evaluate(() => {
      const g = (window as any).__game;
      const f = g.store.snapshot.fleets.find((x: any) => x.ownerId === g.store.playerId);
      const p = g.store.fleetPosition(f);
      return { cam: { x: g.camera.x, y: g.camera.y }, fleet: p };
    });
    expect(Math.hypot(after.cam.x - after.fleet.x, after.cam.y - after.fleet.y)).toBeLessThan(100);
    await page.screenshot({ path: `${SHOTS}/09-home-recenter.png` });
  });
});
