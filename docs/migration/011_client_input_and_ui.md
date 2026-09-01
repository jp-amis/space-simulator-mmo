# Step 011 — Client input & UI

Goal: port `apps/client/src/main.ts` (pointer/wheel/key input, pick + selection,
command issue) and the DOM UI (`ui.ts`, `shipBuilder.ts`, `roster.ts`, `guide.ts`)
from browser events + `document.createElement` to amis **polled input** + **Clay
UI** (tower-d style). Same interactions, same commands, same panels.

Prereqs: 000, 002, 003, 008, 009, 010. Reference (verify signatures in
`../amis-engine/include/amis.h` before compiling):
- Input: `mouse_pos()` (`Vec2i`, design px from bottom-left), `mouse_pos_raw()`,
  `mouse_delta()`, `mouse_wheel()` (`Vec2i`), `mouse_pressed/down/released/up`
  (`MOUSE_LEFT/MIDDLE/RIGHT`), `key_pressed/down/released/up` (`KEY_H`, `KEY_ESCAPE`,
  `KEY_TAB`, `KEY_LSHIFT`…), `text_input_*` / `get_char_pressed` (text fields).
- UI: `ui_clay_init/activate/update/set_dimensions/destroy`, `ui_clay_register_font`,
  `ui_clay_panel/button/text`, `ui_clay_color`, `ui_clay_default_draw`,
  `ui_clay_render`, Clay macros `CLAY/CLAY_ID/CLAY_TEXT/CLAY_STRING/CLAY_AUTO_ID`,
  `Clay_BeginLayout/EndLayout`, `Clay_PointerOver`.
- `tower-d/client/src/scenes/scene_login.cpp` — full Clay layout/update/render loop,
  button hit-test via `Clay_PointerOver(CLAY_ID(...))`, `mouse_released` gating.
- `tower-d/client/src/ui/clay_text_field.{h,cpp}` — single-line text field
  (id entry, ship name); `extend_clay.{h,cpp}` — custom Clay draw (checkbox,
  nine-slice) pattern for the builder grid cells + roster checkboxes.
- Source being ported: `apps/client/src/main.ts`, `ui.ts`, `shipBuilder.ts`,
  `roster.ts`, `guide.ts`. Command encoders: step 003; `client_send`: step 008.

> Coordinate note (from 010 / CREATING_A_GAME §313): amis mouse coords are
> **design-space, bottom-left origin, Y up**. The DOM used top-left `clientX/Y`.
> `pickAt`/pan/zoom feed screen coords into `Camera::screen_to_world` (step 010),
> which already accounts for the Y flip — so pass `mouse_pos()` straight through;
> do **not** flip again here.

---

## 1. Per-frame input polling (replaces DOM event listeners)

`main.ts` wired `pointerdown/move/up`, `wheel`, `keydown`, `resize`. amis is a
polled loop: read state once per `update()`. Port the drag/click/zoom state machine
into an `InputState` updated each frame. Clay must get first refusal on the pointer
(`ui_clay_update` + `Clay_PointerOver`) so clicks on panels don't fall through to
the world (the DOM got this for free via stacked elements).

```cpp
struct InputState {
  bool dragging = false, moved = false;
  amis::Vec2i last{};          // mouse pos at drag start / last frame
};

void input_update(InputState& in, Store& s, ss::Camera& cam, UIState& ui) {
  amis::Vec2i m = amis::mouse_pos();           // design px, bottom-left origin

  // Wheel zoom — keep world point under cursor fixed (port of zoomAt).
  amis::Vec2i wheel = amis::mouse_wheel();
  if (wheel.y != 0) {
    double factor = wheel.y > 0 ? 1.12 : 1.0/1.12;   // confirm wheel.y sign in amis
    cam.zoom_at(m.x, m.y, factor);
  }

  // If the pointer is over any Clay panel, let the UI consume it (no world drag/pick).
  bool over_ui = ui.pointer_over_panels();     // OR of Clay_PointerOver(panel ids)

  if (amis::mouse_pressed(amis::MOUSE_LEFT) && !over_ui) {
    in.dragging = true; in.moved = false; in.last = m;
  }
  if (in.dragging && amis::mouse_down(amis::MOUSE_LEFT)) {
    amis::Vec2i d = amis::mouse_delta();       // or (m - in.last)
    if (std::abs(d.x) + std::abs(d.y) > 3) in.moved = true;
    cam.pan_by_screen(d.x, d.y);               // sign settled in step 010 §1
    in.last = m;
  }
  if (amis::mouse_released(amis::MOUSE_LEFT)) {
    if (in.dragging && !in.moved && !over_ui) handle_click(s, cam, ui, m.x, m.y);  // a click, not a drag
    in.dragging = false;
  }

  // Keys — ignore while a text field is focused (mirror DOM INPUT/SELECT guard).
  if (!amis::text_input_active()) {
    if (amis::key_pressed(amis::KEY_H)) center_on_home(s, cam);
    if (amis::key_pressed(amis::KEY_ESCAPE)) ui.close_top_modal();     // builder/guide
  }

  // Resize: design size is fixed; if window resized, refresh camera view + Clay dims.
  if (amis::window_resized()) {
    cam.resize(amis::app_config()->design_width, amis::app_config()->design_height);
    ui.on_resize();                           // ui_clay_set_dimensions(...)
  }
}
```

> `mouse_delta()` vs `m - in.last`: prefer engine `mouse_delta()` if its polarity
> matches design space (Y up). Verify once; the pan sign was already parameterized
> in 010 §1 `pan_by_screen`. `mouse_wheel().y` sign: confirm which direction is
> "zoom in" (DOM used `deltaY < 0` = in).

---

## 2. Picking + selection (`pickAt` / `handleClick`)

Direct port of `pickAt(sx,sy)` and `handleClick`. `screen_to_world` (step 010)
converts the click to world space; hit-test store snapshot entities with the same
screen-pixel radii, priority fleets → planets → resources → wrecks. `screenPx(px)
= px / zoom` (world units per screen px) is unchanged.

```cpp
enum class PickKind { none, planet, fleet, resource, wreck };
struct Pick { PickKind kind = PickKind::none; std::string id; };

Pick pick_at(const Store& s, const ss::Camera& cam, double sx, double sy) {
  const auto* snap = s.snapshot(); if (!snap) return {};
  ss::Vec2 w = cam.screen_to_world(sx, sy);
  auto screenPx = [&](double px){ return px / cam.zoom; };
  Pick best; double bestD = 1e18;
  for (const auto& f : snap->fleets) {                 // fleets first (drawn on top)
    ss::Vec2 p = s.fleetPosition(f); double d = ss::dist(p, w);
    if (d < screenPx(18) && d < bestD) { best = {PickKind::fleet, f.id}; bestD = d; }
  }
  if (best.kind == PickKind::fleet) return best;       // tight priority as in TS
  for (const auto& pl : snap->planets) {
    double d = ss::dist(pl.position, w);
    if (d < pl.radius + screenPx(16) && d < bestD) { best={PickKind::planet, pl.id}; bestD=d; }
  }
  for (const auto& loc : snap->resourceLocations) {
    double d = ss::dist(loc.position, w);
    if (d < loc.radius + screenPx(16) && d < bestD) { best={PickKind::resource, loc.id}; bestD=d; }
  }
  for (const auto& wr : snap->debris) {
    double d = ss::dist(wr.position, w);
    if (d < screenPx(14) && d < bestD) { best={PickKind::wreck, wr.id}; bestD=d; }
  }
  return best;
}
```

`handle_click` ports the command logic exactly. With **my** fleet selected: click
enemy fleet → pursue; click resource → mine; click wreck → salvage; click empty →
move or attack-move (toggle). Otherwise the click just changes selection. Commands
go through the step-003 encoders + step-008 `client_send` on `Channel::CONTROL`.

```cpp
void handle_click(Store& s, ss::Camera& cam, UIState& ui, double sx, double sy) {
  Pick hit = pick_at(s, cam, sx, sy);
  const auto* snap = s.snapshot();
  const ss::FleetState* selFleet =
      (s.selectedKind == Sel::fleet && !s.selectedId.empty()) ? snap->findFleet(s.selectedId) : nullptr;
  bool mine = selFleet && selFleet->ownerId == s.playerId;

  if (mine) {
    if (hit.kind == PickKind::fleet && hit.id != selFleet->id) {
      const auto* tf = snap->findFleet(hit.id);
      if (tf && tf->ownerId != s.playerId) {
        send_cmd(s, enc_pursue_fleet(s.arena, s.newReqId(), selFleet->id, hit.id));  // C_PURSUE_FLEET
        s.notify("Pursue order issued"); return;
      }
    }
    if (hit.kind == PickKind::resource) {
      send_cmd(s, enc_mine_resource(s.arena, s.newReqId(), selFleet->id, hit.id, std::nullopt)); // C_MINE_RESOURCE
      s.notify("Mining order issued"); return;
    }
    if (hit.kind == PickKind::wreck) {
      send_cmd(s, enc_salvage_wreck(s.arena, s.newReqId(), selFleet->id, hit.id));   // C_SALVAGE_WRECK
      s.notify("Salvage order issued"); return;
    }
    if (hit.kind == PickKind::none) {
      ss::Vec2 target = cam.screen_to_world(sx, sy);
      if (ui.attackMoveMode)
        send_cmd(s, enc_attack_move(s.arena, s.newReqId(), selFleet->id, target)),  // C_ATTACK_MOVE
        s.notify("Attack-move order issued");
      else
        send_cmd(s, enc_move_fleet(s.arena, s.newReqId(), selFleet->id, target)),   // C_MOVE_FLEET
        s.notify("Move order issued");
      return;
    }
  }
  if (hit.kind != PickKind::none) { s.selectedKind = to_sel(hit.kind); s.selectedId = hit.id; }
  else { s.selectedKind = Sel::none; s.selectedId.clear(); }
}
```

`send_cmd`: `client_send(peer, Channel::CONTROL, os.bytes(), os.len)` (step 008
owns the ENet peer + reliable flag). `newReqId()` = the string requestId used for
acks (003 §4). Keep the toast/notify list in the store (step 009).

---

## 3. UI architecture: Clay panels rebuilt each frame

DOM UI kept retained nodes and patched them; Clay is **immediate** — declare the
whole layout inside `Clay_BeginLayout()/Clay_EndLayout()` in `update()`, then
`ui_clay_render` in `render()` (tower-d pattern). This actually *simplifies* the
TS code: the "rebuild only when the content key changes / patch live scalars to
avoid detaching a focused `<select>`" dance (`ui.ts` `inspectorContentKey`,
`patchLiveValues`; `roster.ts` `lastSig`) is **deleted** — immediate mode has no
focus to lose except in text fields (handled by `clay_text_field`).

Setup (once, step 008 or a `UIState::init`), mirroring `scene_login_init`:

```cpp
struct UIState {
  amis::UIClayContext* ctx = nullptr;
  amis::FontId font_id{};
  Clay_RenderCommandArray cmds{};
  // widget slots (Clay is stateless; caller owns widget state)
  ClayTextField id_field;                 // login id entry
  ClayTextField ship_name_field;          // ship builder name
  bool attackMoveMode = false;
  bool showDebug = false, showSensors = true, showFog = true;
  bool rosterOpen = false, builderOpen = false, guideOpen = false;
  std::set<std::string> rosterChecked;    // roster ship checkboxes
  // ship builder edit buffer:
  ss::ShipBlueprint editBp; std::string editingShipId; std::string buildPlanetId;
  std::string selectedModule = "engine"; int rotation = 0;

  void init(amis::MemArena* a, amis::Font* font) {
    ctx = amis::ui_clay_init(a, app_config()->design_width, app_config()->design_height);
    font_id = amis::ui_clay_register_font(font);
    clay_text_field_init(&id_field, font, 16);
    clay_text_field_init(&ship_name_field, font, 16);
  }
};
```

Per frame, before the world input so the UI can claim the pointer:

```cpp
void ui_update(UIState& ui, Store& s, /*callbacks via direct calls*/ ...) {
  amis::ui_clay_update(ui.ctx);            // feeds mouse pos/buttons/wheel to Clay
  Clay_BeginLayout();
  if (!s.connected) layout_id_overlay(ui, s);   // login modal (blocks everything)
  else {
    layout_top_bar(ui, s);                 // resources + Home/Fleets/Guide buttons + status
    layout_engagement_banner(ui, s);       // battle summary banner (plan 013)
    layout_inspector(ui, s);               // right panel: fleet/ship/planet/resource/wreck
    if (ui.rosterOpen)  layout_roster(ui, s);
    if (ui.builderOpen) layout_ship_builder(ui, s);
    if (ui.guideOpen)   layout_guide(ui, s);
    layout_help_bar(ui, s);                // bottom hint + debug/sensors toggles
  }
  ui.cmds = Clay_EndLayout(amis::dt());
  clay_text_field_update(&ui.id_field);
  clay_text_field_update(&ui.ship_name_field);
  handle_ui_clicks(ui, s);                 // Clay_PointerOver(...) + mouse_released
}
```

Render (in the scene render callback, after the world `RenderFrame`, step 010 §7):

```cpp
amis::ui_clay_render(rf, ui.cmds, /* UIClayDraw* for custom widgets */ &clay_custom_draw);
clay_text_field_render(&ui.id_field, rf, &id_style);
clay_text_field_render(&ui.ship_name_field, rf, &name_style);
```

Button/click pattern (copy tower-d): give each interactive element `CLAY_ID("...")`,
then after `Clay_EndLayout` test `if (amis::mouse_released(MOUSE_LEFT) &&
Clay_PointerOver(CLAY_ID("...")))`. `pointer_over_panels()` (used in §1) ORs
`Clay_PointerOver` over the root panel ids so world input is suppressed under UI.

---

## 4. Panels (port target-by-target)

### 4.1 ID overlay (`ui.ts` build) — login modal
Full-screen dark panel, title, a `clay_text_field` (id entry, `maxLength` 24) +
"Connect" button + "How to play" link. On Connect (or `KEY_RETURN` while focused):
`s.playerId = text; net_connect(...)` then `C_HELLO` (003). This replaces the DOM
overlay + `idInput`. Blocks the rest of the UI until `s.connected`.

### 4.2 Top resource bar
`metal`/`fuel` from `snap->you`, `⌂ Home` (→ `center_on_home`), `☰ Fleets`
(toggles `rosterOpen`), `📖 Guide` (toggles `guideOpen`), connection status colored
by `net.status`. All live values are just read each frame — no `patchLiveValues`.

### 4.3 Inspector (right panel) — the big one
Switch on `s.selectedKind`, porting each branch of `renderInspector()`:
- **planet**: name, owner, stored metal/fuel (+rates/s), construction queue list,
  "Build ship (120m/40f)" → opens builder in **build** mode for `planetId`.
- **fleet** (own only): count, status, hint text, **doctrine + formation +
  orders** (§4.3a), **mining operation** controls (§4.3b), ship list (each row:
  name+hull → select ship; cargo chip; ✎ → open builder edit).
- **ship**: hull, thrust/turn, shield/sensor, power (red if underpowered), cargo,
  "Edit in ship builder", **ship doctrine** selects (formationRole / preferredRange
  / targetPriority) → `C_SET_SHIP_DOCTRINE`.
- **resource**: deposits (resource/reserves/richness/accessibility), station
  storage line **or** "Build mining station (300m/120f)" → `C_BUILD_STATION`.
- **wreck**: salvage totals + hint.

#### 4.3a Doctrine / formation / orders (fleet)
The DOM `<select>`s become Clay dropdowns (or a row of selectable buttons — simpler
in immediate mode). Preset list `{hold_fire, return_fire, attack_on_sight, pursue,
flee_if_attacked}` → `C_SET_DOCTRINE(fleetId, preset:u8)`. Formation list `{column,
line, wedge, echelon, box, screen, protect, loose}` → `C_SET_FORMATION(fleetId,
formation:u8)`. "Hold" → `C_HOLD_FLEET`; "Unload" → `C_UNLOAD_CARGO(fleetId,
homePlanetId)`; "attack-move" checkbox → toggles `ui.attackMoveMode` (consumed in
§2). Enum→u8 mapping is the frozen wire order from 002/003 — reuse the shared enums,
don't re-index.

> Doctrine sliders: the prompt mentions aggression/pursuit/cohesion/survival
> sliders. `FleetDoctrine` (002) carries those four scalars, but the current
> `ui.ts` only exposes the **preset** dropdown (no sliders) and `C_SET_DOCTRINE`
> only carries `preset:u8` (003 §4). So for v1 port the **preset selector** only.
> If per-axis sliders are wanted, that needs a protocol change (extend
> `C_SET_DOCTRINE` with the four f64s) — flag as unresolved, do not invent the
> wire fields here.

Representative Clay button issuing a command (tower-d style):

```cpp
CLAY(CLAY_ID("OrderHold"), amis::ui_clay_button(&btn_style)) {
  CLAY_TEXT(CLAY_STRING("Hold"), amis::ui_clay_text(&btn_label));
}
// after Clay_EndLayout:
if (amis::mouse_released(amis::MOUSE_LEFT) && Clay_PointerOver(CLAY_ID("OrderHold")))
  send_cmd(s, enc_hold_fleet(s.arena, s.newReqId(), fleetId));      // C_HOLD_FLEET
```

Preset picker as a button row (immediate-mode friendly; avoids a stateful dropdown):

```cpp
static const char* PRESETS[] = {"hold_fire","return_fire","attack_on_sight","pursue","flee_if_attacked"};
for (int i=0;i<5;i++) {
  char id[32]; std::snprintf(id,sizeof id,"Preset%d",i);
  bool sel = (int)f->doctrine.preset == i;
  CLAY(CLAY_IDI("Preset", i), amis::ui_clay_button(sel ? &btn_sel : &btn_style)) {
    CLAY_TEXT(clay_str(PRESETS[i]), amis::ui_clay_text(&btn_label));
  }
}
// click handling:
for (int i=0;i<5;i++)
  if (amis::mouse_released(amis::MOUSE_LEFT) && Clay_PointerOver(CLAY_IDI("Preset", i)))
    send_cmd(s, enc_set_doctrine(s.arena, s.newReqId(), f->id, (uint8_t)i));  // C_SET_DOCTRINE
```

#### 4.3b Mining operation controls
If an operation exists for the fleet: show state (`paused`/phase) + "Stop
operation" → `C_CANCEL_OPERATION`. Else "Auto-mine nearest field → home" →
picks nearest sensed resource + home planet, `C_CREATE_OPERATION(fleetId,
locationId, deliveryPlanetId)` (nearest-field logic ports from `main.ts`
`onCreateOperation`).

### 4.4 Roster sidebar (`roster.ts`)
Left panel toggled by `☰ Fleets`. Lists own fleets (id/count/status, `⌖` locate →
`center_on` + select) each with ship rows, then "Docked ships" (own ships in no
fleet). Ship rows carry a **checkbox** (custom Clay widget — port
`extend_clay.cpp`'s checkbox), cargo chip, ✎ edit. Actions: "Create fleet (N)" →
`C_CREATE_FLEET(shipIds[])`; "Add ▾" to a chosen fleet → `C_ADD_SHIPS_TO_FLEET`.
Checkbox state lives in `ui.rosterChecked`. `lastSig`/`patchLive` gymnastics are
dropped (immediate mode).

Checkbox via the extend_clay custom-widget pattern (tower-d `ui_checkbox` +
`CheckboxCustom` + `UIClayCustom` slot, drawn in `draw_custom`):

```cpp
game::CheckboxCustom chk{ .style = &checkbox_style, .checked = ui.rosterChecked.count(shipId) };
amis::UIClayCustom slot{};
CLAY(CLAY_IDI("RosterChk", row_i), game::ui_checkbox(&checkbox_style, &chk, &slot)) {}
// click:
if (amis::mouse_released(amis::MOUSE_LEFT) && Clay_PointerOver(CLAY_IDI("RosterChk", row_i))) {
  if (ui.rosterChecked.count(shipId)) ui.rosterChecked.erase(shipId);
  else ui.rosterChecked.insert(shipId);
}
```

### 4.5 Ship builder (`shipBuilder.ts`)
Full-screen modal (`builderOpen`). A `bp.width × bp.height` grid of clickable cells;
click places/removes the `selectedModule` at `rotation`; a module palette
(`{bridge,reactor,engine,shield,laser,cannon,storage,miningLaser}`) selects the
active module; a rotate button; derived stats + validation errors computed by the
**shared** sim (port `validateBlueprint`/`computeDerived`/`roomsFromBlueprint` into
`shared`/`client` per 002/005 — same core callable client-side, DESIGN §19); a
name `clay_text_field`; Apply/Build (disabled while invalid) + Cancel.

Grid cells: draw each as a Clay button (or a custom quad widget) at `cell=44`px;
placed modules overlay a colored box (`room_color(kind)`) with a 4-char label. Cell
click → mutate `ui.editBp.placements` (port `clickCell`/`cellAt`). On Apply:
- edit mode → `C_UPDATE_BLUEPRINT(shipId, blueprint)`,
- build mode → `C_BUILD_SHIP(planetId, blueprint, name)`.

`Blueprint` is encoded per 003 (`os_blueprint` — placements: moduleType, x, y,
rotation; plus width/height). Reuse that encoder; don't re-serialize here.

```cpp
// grid cell click (x,y in blueprint cells)
if (amis::mouse_released(amis::MOUSE_LEFT) && Clay_PointerOver(CLAY_IDI("BpCell", y*ui.editBp.width + x))) {
  int idx = bp_cell_at(ui.editBp, x, y);
  if (idx >= 0) ui.editBp.placements.erase(ui.editBp.placements.begin()+idx);
  else ui.editBp.placements.push_back({ ui.selectedModule, x, y, ui.rotation });
}
// Apply
if (clicked("BuilderApply") && validate(ui.editBp).empty()) {
  if (ui.editingShipId.size())
    send_cmd(s, enc_update_blueprint(s.arena, s.newReqId(), ui.editingShipId, ui.editBp));
  else
    send_cmd(s, enc_build_ship(s.arena, s.newReqId(), ui.buildPlanetId, ui.editBp,
                               clay_text_field_text(&ui.ship_name_field)));
  ui.builderOpen = false;
}
```

### 4.6 In-app player guide (`guide.ts`) — MUST be ported and kept synced
`guide.ts` is a DOM modal of static how-to-play text (MEMORY: keep synced with
gameplay changes). Port to a scrollable Clay panel (`guideOpen`) opened from the
top bar / login link, closed by button or `KEY_ESCAPE`. Keep the copy identical to
`guide.ts` and update both when gameplay changes (add a note in the guide source so
the sync rule survives the port).

### 4.7 Notifications + engagement banner
Toasts (`store.notifications`, auto-expire 5s) → a bottom-left stack of small Clay
panels colored by kind. Engagement/battle summary banner (plan 013) → a top-center
Clay panel shown when a battle involving the player is active (data from snapshot/
active-region). Both are read-only reflections of the store.

---

## 5. Text input (id entry, ship name)

Use `clay_text_field` (tower-d): `clay_text_field_init` once, `_layout` inside the
Clay block, `_update` after `Clay_EndLayout`, `_render` in render (see §3). The
field calls `text_input_start/stop` on focus; while `text_input_active()` the §1
key handler skips `H`/`ESC` shortcuts (mirrors the DOM `INPUT/SELECT/TEXTAREA`
guard). `clay_text_field_text(&f)` reads the current UTF-8 buffer.

---

## 6. Done when

- No DOM: input is polled; `main.ts`'s pan/zoom/click/select/H-key all work via
  `mouse_*`/`key_*`; drags don't misfire as clicks (>3px threshold preserved);
  clicks over Clay panels don't leak to the world.
- With own fleet selected: click enemy → `C_PURSUE_FLEET`; resource → `C_MINE_
  RESOURCE`; wreck → `C_SALVAGE_WRECK`; empty → `C_MOVE_FLEET`/`C_ATTACK_MOVE`
  (toggle) — same as the TS build.
- Inspector shows fleet/ship/planet/resource/wreck; doctrine preset → `C_SET_
  DOCTRINE`, formation → `C_SET_FORMATION`, ship doctrine → `C_SET_SHIP_DOCTRINE`,
  build/unload/operation/station buttons issue their commands.
- Roster lists fleets + docked ships; checkbox multi-select → `C_CREATE_FLEET` /
  `C_ADD_SHIPS_TO_FLEET`; locate centers the camera.
- Ship builder edits the grid, shows shared-sim derived stats + validation, and
  emits `C_UPDATE_BLUEPRINT` / `C_BUILD_SHIP`.
- Guide modal present and text-synced with `guide.ts`.
- Every command round-trips through the 003 encoder + 008 `client_send` and the
  server acks (`S_ACK`); rejects surface as toasts.

## 7. Unresolved questions

- Doctrine **sliders** (aggression/pursuit/cohesion/survival): port needs a
  protocol change (`C_SET_DOCTRINE` carries only `preset:u8` today). Ship preset-
  only for v1, or extend the wire + server handler now? Default: preset-only,
  defer sliders.
- Clay dropdown for doctrine/formation/ship-doctrine vs button rows: no built-in
  Clay dropdown — button row (shown) is simplest in immediate mode; a real dropdown
  needs a small stateful widget. Default: button rows.
- `mouse_wheel().y` and `mouse_delta()` polarity in design space — confirm "zoom in"
  and pan directions against a live build (tied to camera Y-flip in 010 §1).
- Reuse tower-d's `extend_clay` checkbox/nine-slice wholesale, or minimal custom
  quads? (000 §6 open question.) Default: reuse the checkbox; skip nine-slice art
  (procedural look, no spritesheet) — use `ui_clay_panel`/`button` flat styling.
- Shared blueprint validator/derived-stats: land in `shared` (client+server) or
  duplicate client-side? Default: `shared` (matches 002/005, DESIGN §19).
- Multiple Clay contexts (world HUD vs full-screen modals) or one context with
  z-ordered panels? Default: one context, modals as top panels that OR into
  `pointer_over_panels()`.
- Guide sync: add a lint/checklist so `guide.ts` and the C++ guide copy can't drift?
  Default: manual note in both sources for now.
</content>
