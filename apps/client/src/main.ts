// Browser client bootstrap (DESIGN §9). Wires net → store → Pixi scene + DOM UI,
// handles input (pan/zoom/select/move) and runs the render loop with client-side
// interpolation. The renderer mirrors authoritative snapshots (DESIGN §16 rule 8).

import { Application } from "pixi.js";
import { starterBlueprint } from "@space/simulation";
import type { FleetDto, PlanetDto } from "@space/protocol";
import { Camera } from "./camera.js";
import { NetClient } from "./net.js";
import { Scene } from "./scene.js";
import { Store } from "./store.js";
import { UI } from "./ui.js";
import { ShipBuilder } from "./shipBuilder.js";
import { Roster } from "./roster.js";
import { Guide } from "./guide.js";

const WS_URL =
  (import.meta.env?.VITE_WS_URL as string | undefined) ??
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:8080`;

async function boot(): Promise<void> {
  const root = document.querySelector<HTMLDivElement>("#app")!;
  root.innerHTML = "";
  root.style.cssText = "position:relative;width:100vw;height:100vh;overflow:hidden;";

  const app = new Application();
  await app.init({ background: "#05070c", resizeTo: window, antialias: true });
  root.append(app.canvas);
  app.canvas.style.cssText = "position:absolute;inset:0;";

  const store = new Store();
  const net = new NetClient(WS_URL);
  const camera = new Camera(app.renderer.width, app.renderer.height);
  const scene = new Scene(app, store, camera);

  let editingShipId: string | undefined;
  const builder = new ShipBuilder(root, {
    onApply: (bp) => {
      if (editingShipId) net.command({ type: "updateShipBlueprint", shipId: editingShipId, blueprint: bp });
    },
    onBuild: (planetId, bp, name) => net.command({ type: "buildShip", planetId, blueprint: bp, name }),
  });

  function openShipBuilder(shipId: string): void {
    editingShipId = shipId;
    const ship = store.ship(shipId);
    if (ship) builder.openEdit(ship.blueprint);
  }

  // Select a fleet and center the camera on it (plan 014).
  function locateFleet(fleetId: string): void {
    const f = store.snapshot?.fleets.find((x) => x.id === fleetId);
    if (!f) return;
    store.selectedId = fleetId;
    store.selectedKind = "fleet";
    const p = store.fleetPosition(f);
    camera.centerOn(p.x, p.y);
    camera.zoom = Math.max(camera.zoom, 0.35);
  }

  let roster: Roster;
  const ui = new UI(root, store, net, {
    onConnect: (playerId) => {
      store.playerId = playerId;
      net.connect(playerId);
    },
    onEditShip: openShipBuilder,
    onBuildShip: (planetId) => builder.openBuild(planetId, starterBlueprint()),
    onDoctrineChange: (fleetId, preset) => net.command({ type: "setDoctrine", fleetId, preset }),
    onFormationChange: (fleetId, formation) => net.command({ type: "setFormation", fleetId, formation }),
    onShipDoctrineChange: (shipId, doctrine) => net.command({ type: "setShipDoctrine", shipId, doctrine }),
    onHoldFleet: (fleetId) => net.command({ type: "holdFleet", fleetId }),
    onUnloadCargo: (fleetId) => {
      const planetId = store.snapshot?.you.homePlanetId;
      if (planetId) net.command({ type: "unloadCargo", fleetId, planetId });
    },
    onCreateOperation: (fleetId) => {
      const snap = store.snapshot;
      const f = snap?.fleets.find((x) => x.id === fleetId);
      if (!snap || !f) return;
      const c = store.fleetPosition(f);
      // Nearest sensed resource location + the player's home planet as the delivery point.
      let nearest: { id: string; d: number } | undefined;
      for (const loc of snap.resourceLocations) {
        const d = Math.hypot(loc.position.x - c.x, loc.position.y - c.y);
        if (!nearest || d < nearest.d) nearest = { id: loc.id, d };
      }
      if (!nearest) return store.notify("No known resource field in range", "error");
      net.command({ type: "createOperation", fleetId, locationId: nearest.id, deliveryPlanetId: snap.you.homePlanetId });
      store.notify("Mining operation started");
    },
    onCancelOperation: (operationId) => net.command({ type: "cancelOperation", operationId }),
    onBuildStation: (locationId) => {
      const planetId = store.snapshot?.you.homePlanetId;
      if (planetId) net.command({ type: "buildStation", locationId, planetId });
    },
    onAttackMoveMode: (on) => (attackMoveMode = on),
    onCenterHome: () => centerOnHome(),
    onToggleRoster: () => roster.toggle(),
    onOpenGuide: () => guide.open(),
  });
  const guide = new Guide(root);
  let attackMoveMode = false;
  ui.onToggleDebug = (on) => (scene.showDebug = on);
  ui.onToggleSensors = (on) => (scene.showSensors = on);

  roster = new Roster(root, store, net, { onLocateFleet: locateFleet, onEditShip: openShipBuilder });

  net.onStatus((s) => {
    if (s === "connected") ui.setConnected();
  });
  net.onMessage((msg) => {
    store.applyServer(msg);
    if (msg.type === "welcome") {
      // Center camera on home planet once we have a snapshot.
      queueMicrotask(() => centerOnHome());
    }
    if (msg.type === "snapshot" && !centered) centerOnHome();
    // Participants are auto-subscribed to their battle server-side (startBattle),
    // so no explicit subscribeBattle is needed here (avoids a late "no such battle").
  });

  let centered = false;
  function centerOnHome(): void {
    const home = store.snapshot?.planets.find((p) => p.id === store.snapshot?.you.homePlanetId);
    if (home) {
      camera.centerOn(home.position.x, home.position.y);
      camera.zoom = 0.18;
      centered = true;
    }
  }

  // ---- Input (DESIGN §9.2) ----
  let dragging = false;
  let moved = false;
  let last = { x: 0, y: 0 };
  const canvas = app.canvas;
  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    moved = false;
    last = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    camera.panByScreen(dx, dy);
    last = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener("pointerup", (e) => {
    if (dragging && !moved) handleClick(e.clientX, e.clientY);
    dragging = false;
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    camera.zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12);
  }, { passive: false });
  window.addEventListener("resize", () => camera.resize(app.renderer.width, app.renderer.height));
  window.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA")) return;
    if (e.key === "h" || e.key === "H") centerOnHome();
  });

  type PickKind = "planet" | "fleet" | "resource" | "wreck";
  function pickAt(sx: number, sy: number): { id: string; kind: PickKind } | undefined {
    const snap = store.snapshot;
    if (!snap) return undefined;
    const world = camera.screenToWorld(sx, sy);
    const screenPx = (px: number) => px / camera.zoom; // world units per `px` screen pixels
    // Fleets first (small, drawn on top) — tight pick radius in screen space.
    let best: { id: string; kind: PickKind; d: number } | undefined;
    for (const f of snap.fleets) {
      const p = store.fleetPosition(f);
      const d = Math.hypot(p.x - world.x, p.y - world.y);
      if (d < screenPx(18) && (!best || d < best.d)) best = { id: f.id, kind: "fleet", d };
    }
    if (best) return { id: best.id, kind: best.kind };
    for (const pl of snap.planets) {
      const d = Math.hypot(pl.position.x - world.x, pl.position.y - world.y);
      if (d < pl.radius + screenPx(16) && (!best || d < best.d)) best = { id: pl.id, kind: "planet", d };
    }
    for (const loc of snap.resourceLocations) {
      const d = Math.hypot(loc.position.x - world.x, loc.position.y - world.y);
      if (d < loc.radius + screenPx(16) && (!best || d < best.d)) best = { id: loc.id, kind: "resource", d };
    }
    for (const w of snap.debris) {
      const d = Math.hypot(w.position.x - world.x, w.position.y - world.y);
      if (d < screenPx(14) && (!best || d < best.d)) best = { id: w.id, kind: "wreck", d };
    }
    return best ? { id: best.id, kind: best.kind } : undefined;
  }

  function handleClick(sx: number, sy: number): void {
    const hit = pickAt(sx, sy);
    const selFleet =
      store.selectedKind === "fleet" && store.selectedId
        ? store.snapshot?.fleets.find((f: FleetDto) => f.id === store.selectedId)
        : undefined;
    const mine = selFleet && selFleet.ownerId === store.playerId;

    // With my fleet selected: click an enemy fleet = pursue; click empty = move/attack-move.
    if (mine) {
      if (hit && hit.kind === "fleet" && hit.id !== selFleet!.id) {
        const targetFleet = store.snapshot?.fleets.find((f) => f.id === hit.id);
        if (targetFleet && targetFleet.ownerId !== store.playerId) {
          net.command({ type: "pursueFleet", fleetId: selFleet!.id, targetFleetId: hit.id });
          store.notify("Pursue order issued");
          return;
        }
      }
      // Click a resource field = mine it.
      if (hit && hit.kind === "resource") {
        net.command({ type: "mineResource", fleetId: selFleet!.id, locationId: hit.id });
        store.notify("Mining order issued");
        return;
      }
      // Click a wreck = send the fleet to salvage it.
      if (hit && hit.kind === "wreck") {
        net.command({ type: "salvageWreck", fleetId: selFleet!.id, debrisId: hit.id });
        store.notify("Salvage order issued");
        return;
      }
      if (!hit) {
        const target = camera.screenToWorld(sx, sy);
        if (attackMoveMode) {
          net.command({ type: "attackMove", fleetId: selFleet!.id, target });
          store.notify("Attack-move order issued");
        } else {
          net.command({ type: "moveFleet", fleetId: selFleet!.id, target });
          store.notify("Move order issued");
        }
        return;
      }
    }
    if (hit) {
      store.selectedId = hit.id;
      store.selectedKind = hit.kind;
    } else {
      store.selectedId = undefined;
      store.selectedKind = undefined;
    }
  }

  // ---- Render loop ----
  app.ticker.add((ticker) => {
    store.updateActiveShips();
    store.updateProjectiles(ticker.deltaMS);
    scene.render();
    ui.update();
    roster.update();
  });

  // Expose for e2e tests / debugging.
  (window as unknown as Record<string, unknown>).__game = { store, net, camera, scene, pickAt: (x: number, y: number) => pickAt(x, y) };
  void (null as unknown as PlanetDto);
}

void boot();
