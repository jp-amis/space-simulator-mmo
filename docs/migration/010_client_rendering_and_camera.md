# Step 010 — Client rendering & camera

Goal: port `apps/client/src/scene.ts` + `apps/client/src/camera.ts` (PixiJS
immediate-mode redraw) to amis's immediate-mode `RenderFrame` API. Same visuals,
same layer order, same 3-tier ship LOD, same combat FX and fog-of-war — driven by
the client store (step 009). No new gameplay.

Prereqs: 000, 002, 003, 008, 009. Reference (verify signatures before compiling):
- `../amis-engine/include/amis.h` — `render_frame_create/render/destroy`,
  `render_frame_draw_quad/circle/circle_outline/line/polyline/polygon/text`,
  `render_frame_set_view_matrix`, `Camera2D` + `camera2d_get_view_matrix` /
  `camera2d_screen_to_world` / `camera2d_world_to_screen`, `mat4f_*`,
  `render_frame_set_mask` + `MaskParams`, `render_frame_set_scissor`,
  `frame_buffer_create` + `back_buffer` + `frame_buffer_get_texture`, `Color`,
  `color_hex`, `Font` + `render_frame_draw_text`.
- `../amis-engine/CREATING_A_GAME.md` §"Coordinate System" (0,0 = **bottom-left**,
  Y **up**), §"Mouse Input" (design-space, bottom-left), rendering examples.
- `tower-d/client/src/scenes/scene_login.cpp` / `scene_game.cpp` — the
  frame-buffer + `render_frame_render` + blit pattern to copy.
- Source being ported: `apps/client/src/scene.ts`, `apps/client/src/camera.ts`.

> Coordinate-system warning (locked, do not violate). PixiJS is top-left origin,
> Y **down**. amis is bottom-left origin, Y **up** (`CREATING_A_GAME.md` line
> 313; `mouse_pos()` returns pixels from bottom-left). Every `worldToScreen`
> ported below flips Y. We keep sim/world data in `ss::Vec2` (double, unflipped —
> the server never knew about screens); the flip lives **only** in the camera's
> `world_to_screen` / `screen_to_world` and nowhere else. This mirrors 002's rule:
> `amis::Vec2f` appears at draw time only.

---

## 1. `Camera` port (`client/src/render/camera.h`)

Plain struct, direct port of `camera.ts`. `x,y` = world point at screen center;
`zoom` in `[0.02, 2.5]`; `viewW/viewH` = design size (`app_config()->design_width/height`).
The only change vs TS is the **Y flip** in the two transforms.

```cpp
#pragma once
#include "shared/math.h"      // ss::Vec2 (double)
#include "amis.h"             // amis::Vec2f, Camera2D, mat4f_*

namespace ss {

struct Camera {
  double x = 0, y = 0;        // world coord at screen center
  double zoom = 0.12;
  double minZoom = 0.02, maxZoom = 2.5;
  double viewW = 1280, viewH = 720;

  void resize(double w, double h) { viewW = w; viewH = h; }

  // World (Y-up sim space) -> amis design pixels (Y-up, bottom-left origin).
  // Sim +y and amis +y agree, so NO flip is needed IF we treat sim as Y-up.
  // PixiJS treated sim +y as screen-down; amis treats screen +y as up. To keep
  // the map looking identical to the Pixi build we flip Y here (negate the y term).
  amis::Vec2f world_to_screen(Vec2 w) const {
    return {
      (float)((w.x - x) * zoom + viewW * 0.5),
      (float)((-(w.y - y)) * zoom + viewH * 0.5),   // <-- Y flip vs PixiJS
    };
  }
  Vec2 screen_to_world(double sx, double sy) const {
    return {
      (sx - viewW * 0.5) / zoom + x,
      -((sy - viewH * 0.5) / zoom) + y,             // <-- inverse Y flip
    };
  }

  // Pan: drag right/up should move the world the same way it did in Pixi.
  // dyScreen is in amis design pixels (Y up). PixiJS dy was Y-down; negate it
  // so a physical "drag up" still pans the same direction. Confirm sign against
  // the input step (011) once mouse_delta() polarity is verified.
  void pan_by_screen(double dxScreen, double dyScreen) {
    x -= dxScreen / zoom;
    y += dyScreen / zoom;                            // note '+=' (Y-up)
  }

  // Zoom keeping the world point under the cursor fixed (port of zoomAt).
  void zoom_at(double sx, double sy, double factor) {
    Vec2 before = screen_to_world(sx, sy);
    zoom = std::min(maxZoom, std::max(minZoom, zoom * factor));
    Vec2 after = screen_to_world(sx, sy);
    x += before.x - after.x;
    y += before.y - after.y;
  }
  void center_on(Vec2 w) { x = w.x; y = w.y; }
};

}
```

> The Y-flip is a **visual** choice, not a correctness one. If we decide the map
> should read Y-up (north = up), drop the two negations and the `pan_by_screen`
> becomes `y -= dyScreen/zoom`. Pick one and document it once — parity harness
> (012) will screenshot-diff, so lock it before 012. Default: match PixiJS look
> (flip Y as above).

### 1a. View matrix vs manual `world_to_screen` (recommended: view matrix)

Two equivalent ways to draw the world. **Recommend the view-matrix approach**:
build one `Mat4f` from the camera, hand it to the `RenderFrame`, then draw every
world element in raw `ss::Vec2` world coords (just cast to `Vec2f`). No per-element
transform. Use the manual path only for screen-space overlays (fog veil rect, HUD).

amis ships a `Camera2D` + `camera2d_get_view_matrix`. Map our `Camera` to it:

```cpp
// Build an amis Camera2D matching our ss::Camera (view-matrix path).
amis::Mat4f ss_camera_view(const ss::Camera& c) {
  amis::Camera2D cam{};
  cam.target = { (float)c.x, (float)c.y };            // world point centered
  cam.offset = { (float)(c.viewW*0.5), (float)(c.viewH*0.5) };
  cam.zoom   = (float)c.zoom;
  amis::Mat4f v = amis::camera2d_get_view_matrix(&cam);
  // amis Camera2D is Y-up already; if a Y flip is desired for parity, compose
  // with mat4f_flip_y_offset(design_height). Confirm Camera2D handedness in
  // amis.h before composing (screen_to_world round-trip test in step 012).
  return v;
}
```

Then per frame:

```cpp
auto* rf = amis::render_frame_create();               // per-frame, arena-backed
amis::render_frame_set_view_matrix(rf, ss_camera_view(cam));  // world layers
draw_map(rf, ...); draw_ships(rf, ...); draw_fx(rf, ...);     // all in world coords
amis::render_frame_reset_view_matrix(rf);             // back to screen space
draw_fog_veil(rf, ...); draw_hud_debug(rf, ...);      // screen-space overlays
amis::render_frame_render(rf, data->fb);              // or back_buffer()
amis::render_frame_destroy(rf);
```

With the view matrix set, world draws pass world coords directly:
`amis::render_frame_draw_circle(rf, {(float)p.x,(float)p.y}, r_world, col)` where
`r_world` is a **world** radius (the matrix scales it). Screens-space sizes (the
`Math.max(3, r*zoom)` clamps in `scene.ts`) then need dividing by `zoom` to keep a
minimum on-screen size — see §4. Given that many of scene.ts's sizes are
"px clamped, not world-scaled", the **manual `world_to_screen`** path is often
simpler for this game; both are shown, mix as convenient.

---

## 2. Frame structure & layer order

`scene.ts` ordered PixiJS containers: `bg`, then `world{ trajectory, planet,
overlay, fleet, combat, fogVeil(+mask), labels }`. amis has no retained scene
graph — order == call order into one `RenderFrame`. Port `Scene::render()` to a
single function that issues draws in this exact sequence:

```cpp
void scene_render(amis::RenderFrame* rf, const Store& s, const ss::Camera& cam) {
  render_background(rf, s, cam);      // parallax starfield (screen space)
  amis::render_frame_set_view_matrix(rf, ss_camera_view(cam));
  render_map(rf, s, cam);            // sensor rings, debris, resources, stations, planets, move-lines, fleet chevrons, labels
  render_ships(rf, s, cam);          // lock lines, projectiles, explosions, beams, ship LOD
  amis::render_frame_reset_view_matrix(rf);
  render_fog(rf, s, cam);            // dark veil, inverse-masked by sensor bubbles (screen space)
  if (s.showDebug) render_debug(rf, s, cam);
}
```

Labels: PixiJS pooled `Text`. amis has `render_frame_draw_text(rf, font, str,
size_px, pos, color)` — immediate, no pool needed. Keep one loaded `Font*`
(`font_load`, step 008 owns it) and draw labels last within `render_map` (or in a
screen-space pass so text stays pixel-crisp regardless of zoom — recommended:
compute the label anchor via `cam.world_to_screen` and draw in screen space).

Color: `scene.ts` uses `0xRRGGBB` ints + alpha floats. amis `Color{r,g,b,a}`.
Helper:

```cpp
inline amis::Color rgba(int hex, float a = 1.f) {
  amis::Color c = amis::color_hex(hex);              // 0xRRGGBB
  c.a = (uint8_t)(a * 255.f); return c;
}
```

Port `colorFor(ownerId, myId)` (the FNV-ish hash over the owner string picking one
of `OWNER_COLORS`) verbatim — it is deterministic and must match TS for parity.

---

## 3. Background starfield (parallax)

`renderBackground()`: fill `0x05070c`, then 600 seeded stars across 3 parallax
layers, wrapped modulo the viewport, drawn as tiny alpha circles. This is a
**screen-space** pass (no view matrix). Port the LCG seed exactly
(`s = imul(s,1664525)+1013904223`) so the field is identical.

```cpp
struct Star { float x, y, r, a; int layer; };
// generate once (step 008 / scene init), same LCG as scene.ts generateStars()

void render_background(amis::RenderFrame* rf, const Store& s, const ss::Camera& cam) {
  amis::render_frame_draw_quad(rf, {0,0}, {(float)cam.viewW,(float)cam.viewH}, rgba(0x05070c));
  for (const Star& st : s.stars) {
    float parallax = 0.2f + st.layer * 0.25f;
    float w = (float)cam.viewW, h = (float)cam.viewH;
    float sx = std::fmod(std::fmod(st.x - (float)cam.x*parallax, w) + w, w);
    float sy = std::fmod(std::fmod(st.y - (float)cam.y*parallax, h) + h, h);
    amis::render_frame_draw_circle(rf, {sx, sy}, st.r, rgba(0xffffff, st.a), 8);
  }
}
```

> `draw_quad` origin is bottom-left in amis; the full-screen fill is origin-agnostic.
> Star wrap math is unchanged from TS (screen space, sign of Y irrelevant since it
> wraps). Use few `segments` (6–8) for tiny circles — cheaper, invisible difference.

---

## 4. Map layer

Direct port of `renderMap()`. With the view matrix set, positions pass as world
coords; **on-screen minimum sizes** (`Math.max(3, radius*zoom)`) must be converted:
a world radius of `r_world` renders at `r_world*zoom` px, so to reproduce
`max(min_px, r*zoom)` use `r_world = max(min_px/zoom, r)`. To avoid that mental
juggling for the many clamps, the map layer is a good candidate for the **manual
`world_to_screen`** path (draw in screen space, radii already in px). Shown that way:

```cpp
void render_map(amis::RenderFrame* rf, const Store& s, const ss::Camera& cam) {
  const auto* snap = s.snapshot();                 // step 009 cached S_SNAPSHOT
  if (!snap) return;
  const std::string& me = s.playerId;

  // 4.1 Sensor range rings (own fleets + owned stations), showSensors gate.
  if (s.showSensors) {
    auto ring = [&](amis::Vec2f c, double rWorld) {
      float rpx = (float)(rWorld * cam.zoom);
      amis::render_frame_draw_circle(rf, c, rpx, rgba(0x54c8ff, 0.04f));
      amis::render_frame_draw_circle_outline(rf, c, rpx, 1.f, rgba(0x54c8ff, 0.15f));
    };
    for (const auto& f : snap->fleets)
      if (f.ownerId == me && f.sensorRange > 0)
        ring(cam.world_to_screen(s.fleetPosition(f)), f.sensorRange);
    for (const auto& st : snap->stations)
      if (st.ownerId == me)
        ring(cam.world_to_screen(st.position), ss::cfg::STATION.sensorRange);
  }

  // 4.2 Debris — spinning ♢, cosmetic bob (mining_float), selection halo.
  double now = s.nowMs();
  for (const auto& d : snap->debris) {
    ss::Vec2 fl = mining_float(d.id, now);
    amis::Vec2f c = cam.world_to_screen({ d.position.x + fl.x*0.6, d.position.y + fl.y*0.6 });
    float r = std::max(3.f, (float)(6*cam.zoom));
    double spin = now/900.0 + phase_of(d.id);
    float cs = (float)std::cos(spin), sn = (float)std::sin(spin);
    auto pt = [&](float dx, float dy){ return amis::Vec2f{ c.x+dx*cs-dy*sn, c.y+dx*sn+dy*cs }; };
    amis::Vec2f diamond[4] = { pt(0,-r), pt(r,0), pt(0,r), pt(-r,0) };
    amis::render_frame_draw_polygon(rf, diamond, 4, rgba(0x1e2b26, 0.9f));
    amis::render_frame_draw_polygon_outline(rf, diamond, 4, 1.5f, rgba(0x9fead0, 0.85f));
    if (s.selectedKind == Sel::wreck && s.selectedId == d.id)
      amis::render_frame_draw_circle_outline(rf, c, r+6, 2.f, rgba(0xffffff, 0.9f));
  }

  // 4.3 Resource fields — 5 amber blobs in a ring, label above zoom>0.06.
  for (const auto& loc : snap->resourceLocations) {
    amis::Vec2f c = cam.world_to_screen(loc.position);
    float r = std::max(2.5f, (float)(loc.radius*cam.zoom));
    for (int i=0;i<5;i++){ float a=(float)(i/5.0*2*AMIS_PI);
      amis::render_frame_draw_circle(rf, {c.x+std::cos(a)*r*0.7f, c.y+std::sin(a)*r*0.7f},
        std::max(1.2f, r*0.4f), rgba(0xffb454, 0.85f)); }
    if (s.selectedKind==Sel::resource && s.selectedId==loc.id)
      amis::render_frame_draw_circle_outline(rf, c, r+8, 2.f, rgba(0xffffff,0.9f));
    if (cam.zoom > 0.06) draw_label(rf, loc.name, {c.x, c.y+r+3}, rgba(0xffcf8f), 10);
  }

  // 4.4 Stations — hex marker + core dot + label (port poly of 6 verts).
  for (const auto& st : snap->stations) { /* same shape as scene.ts, draw_polygon+outline */ }

  // 4.5 Planets — atmosphere halo, body, ring, core, selection halo, label.
  for (const auto& p : snap->planets) {
    amis::Vec2f c = cam.world_to_screen(p.position);
    float r = std::max(3.f, (float)(p.radius*cam.zoom));
    amis::Color col = color_for(p.ownerId, me);
    amis::render_frame_draw_circle(rf, c, r*1.5f, with_a(col, 0.06f));
    amis::render_frame_draw_circle(rf, c, r, rgba(0x1b2433));
    amis::render_frame_draw_circle_outline(rf, c, r, 1.5f, with_a(col, 0.9f));
    amis::render_frame_draw_circle(rf, c, r*0.55f, with_a(col, 0.25f));
    if (s.selectedKind==Sel::planet && s.selectedId==p.id)
      amis::render_frame_draw_circle_outline(rf, c, r+6, 2.f, rgba(0xffffff,0.9f));
    if (cam.zoom>0.06 || p.ownerId==me) draw_label(rf, p.name, {c.x,c.y+r+3}, rgba(0x9fb2c8), 11);
  }

  // 4.6 Move lines — own fleet centroid -> anchor + crosshair goal marker.
  for (const auto& f : snap->fleets) {
    if (f.ownerId != me) continue;
    auto anchor = s.fleetAnchor(f); if (!anchor) continue;
    ss::Vec2 cw = s.fleetPosition(f);
    if (ss::dist(*anchor, cw) < 24) continue;       // parked
    amis::Vec2f a = cam.world_to_screen(cw), b = cam.world_to_screen(*anchor);
    amis::Color col = color_for(f.ownerId, me);
    amis::render_frame_draw_line(rf, a, b, 1.f, with_a(col, 0.35f));
    amis::render_frame_draw_circle_outline(rf, b, 4, 1.f, with_a(col, 0.6f));
    amis::render_frame_draw_line(rf, {b.x-4,b.y},{b.x+4,b.y}, 1.f, with_a(col,0.5f));
    amis::render_frame_draw_line(rf, {b.x,b.y-4},{b.x,b.y+4}, 1.f, with_a(col,0.5f));
  }

  // 4.7 Fleet chevrons — oriented toward anchor while moving, count label, halo.
  for (const auto& f : snap->fleets) {
    ss::Vec2 pw = s.fleetPosition(f);
    amis::Vec2f c = cam.world_to_screen(pw);
    amis::Color col = color_for(f.ownerId, me);
    double ang = 0; auto anchor = s.fleetAnchor(f);
    if (anchor && f.status == ss::FleetStatus::moving)
      ang = std::atan2(anchor->y - pw.y, anchor->x - pw.x);
    // Screen-space heading: if the camera flips Y, negate ang here so the
    // chevron points the correct on-screen direction. Confirm in step 012.
    draw_chevron(rf, c, -ang, 8.f, col);
    if (s.selectedKind==Sel::fleet && s.selectedId==f.id)
      amis::render_frame_draw_circle_outline(rf, c, 14, 2.f, rgba(0xffffff,0.9f));
    draw_label(rf, std::to_string(f.shipCount), {c.x, c.y-20}, col, 10);
  }
}
```

`draw_chevron` (port of `drawChevron`) — 4 local points, rotate, draw as a closed
polygon with a faint white outline:

```cpp
void draw_chevron(amis::RenderFrame* rf, amis::Vec2f o, double ang, float size, amis::Color col) {
  amis::Vec2f local[4] = {{size,0},{-size*0.7f,size*0.7f},{-size*0.3f,0},{-size*0.7f,-size*0.7f}};
  float cs=(float)std::cos(ang), sn=(float)std::sin(ang);
  amis::Vec2f w[4];
  for (int i=0;i<4;i++) w[i] = { o.x+local[i].x*cs-local[i].y*sn, o.y+local[i].x*sn+local[i].y*cs };
  amis::render_frame_draw_polygon(rf, w, 4, col);
  amis::render_frame_draw_polygon_outline(rf, w, 4, 1.f, rgba(0xffffff, 0.5f));
}
```

---

## 5. Ships (3-tier LOD) + combat FX

Direct port of `renderShips()`, keyed on `cam.zoom`. Order inside the pass matches
scene.ts: lock lines, projectiles, explosions, mining/unload beams, then ships.
All in screen space via `world_to_screen` (or world space via the matrix; sizes are
mostly px-clamped so screen space is simpler here).

Data comes from the store (step 009): `activeShips` (`shown` interpolated pos +
`dto` kinematics), `projectiles` (`shown` + `dto.kind`/`velocity`), `explosions`
(`{x,y,startMs}`), and the **cached blueprint/rooms by shipId** (per 003 §8 the
stream carries no blueprint; detailed LOD looks up `s.blueprintFor(shipId)`).

```cpp
void render_ships(amis::RenderFrame* rf, const Store& s, const ss::Camera& cam) {
  const std::string& me = s.playerId;
  double now = s.nowMs();

  // 5.1 Lock lines — ship -> targetShipId (own = amber, enemy = red), a=0.25.
  for (const auto& [id, as] : s.activeShips) {
    if (!as.dto.alive || !as.dto.targetShipId) continue;
    auto it = s.activeShips.find(*as.dto.targetShipId); if (it==s.activeShips.end()) continue;
    amis::Vec2f a = cam.world_to_screen(as.shown), b = cam.world_to_screen(it->second.shown);
    bool mine = as.dto.ownerId == me;
    amis::render_frame_draw_line(rf, a, b, 1.f, rgba(mine?0xff9e3d:0xff5c5c, 0.25f));
  }

  // 5.2 Projectiles — laser = bright streak along velocity; cannon = round tracer.
  for (const auto& [id, p] : s.projectiles) {
    amis::Vec2f c = cam.world_to_screen(p.shown);
    if (p.dto.kind == "laser") {
      ss::Vec2 v = p.dto.velocity.value_or(ss::Vec2{1,0});
      double len = std::max(1.0, ss::len(v));
      amis::Vec2f tail = cam.world_to_screen({ p.shown.x - v.x/len*26, p.shown.y - v.y/len*26 });
      amis::render_frame_draw_line(rf, tail, c, 1.6f, rgba(0x8ef0ff, 0.9f));
      amis::render_frame_draw_circle(rf, c, 1.6f, rgba(0xe6ffff), 8);
    } else {
      amis::render_frame_draw_circle(rf, c, 2.8f, rgba(0xffb454), 10);
      amis::render_frame_draw_circle(rf, c, 1.4f, rgba(0xfff2a8), 8);
    }
  }

  // 5.3 Explosions — expanding ring + core flash + sparks over 550ms, then GC.
  //     Additive blend reads best for the glow (optional): set/reset around this block.
  amis::render_frame_set_blend_mode(rf, amis::BlendMode::Additive);
  for (const auto& ex : s.explosions) {
    float t = std::min(1.f, (float)((now - ex.startMs)/550.0));
    amis::Vec2f c = cam.world_to_screen({ex.x, ex.y});
    float r = (10 + t*64) * std::max(0.55f, (float)cam.zoom);
    float a = (1-t)*0.9f;
    amis::render_frame_draw_circle_outline(rf, c, r, 2.5f, rgba(0xffd166, a));
    amis::render_frame_draw_circle(rf, c, r*0.6f, rgba(0xff7b3d, a*0.55f));
    if (t < 0.45f) amis::render_frame_draw_circle(rf, c, r*0.4f, rgba(0xffffff, (0.45f-t)*2));
    for (int i=0;i<6;i++){ float ang=(float)(i/6.0*2*AMIS_PI + std::fmod(ex.startMs,100)/16.0);
      float d=r*(0.9f+0.5f*t);
      amis::render_frame_draw_circle(rf, {c.x+std::cos(ang)*d, c.y+std::sin(ang)*d},
        std::max(1.f,(float)(2*cam.zoom)), rgba(0xffe08a, a)); }
  }
  amis::render_frame_set_blend_mode(rf, amis::BlendMode::Alpha);
  // store prunes explosions where now-startMs > 550 (step 009).

  // 5.4 Mining beams (amber, pulsing) + unload beams (green, pulsing).
  const auto* snap = s.snapshot();
  if (snap) {
    for (const auto& [id, as] : s.activeShips) {
      if (!as.dto.alive || !as.dto.miningLocationId) continue;
      const auto* loc = snap->findResource(*as.dto.miningLocationId); if (!loc) continue;
      ss::Vec2 off = mining_float(as.dto.shipId, now);
      amis::Vec2f from = cam.world_to_screen({as.shown.x+off.x, as.shown.y+off.y});
      amis::Vec2f to   = cam.world_to_screen(loc->position);
      float pulse = 0.5f + 0.5f*(float)std::sin(now/110.0 + phase_of(as.dto.shipId));
      amis::render_frame_draw_line(rf, from, to, 1.5f, rgba(0xffcf6a, 0.25f+0.45f*pulse));
      amis::render_frame_draw_circle(rf, to, std::max(2.f,(float)(4*cam.zoom)), rgba(0xffe6a8, 0.4f+0.4f*pulse));
    }
    for (const auto& [id, as] : s.activeShips) {
      if (!as.dto.alive || !as.dto.unloadLocationId) continue;
      const auto* pl = snap->findPlanet(*as.dto.unloadLocationId); if (!pl) continue;
      amis::Vec2f from = cam.world_to_screen(as.shown), to = cam.world_to_screen(pl->position);
      float pulse = 0.5f + 0.5f*(float)std::sin(now/120.0 + phase_of(as.dto.shipId));
      amis::render_frame_draw_line(rf, from, to, 1.5f, rgba(0x6be3a0, 0.22f+0.4f*pulse));
      amis::render_frame_draw_circle(rf, from, std::max(1.5f,(float)(3*cam.zoom)), rgba(0xbdffdb, 0.4f+0.4f*pulse));
    }
  }

  // 5.5 Ships with LOD.
  bool detailed = cam.zoom > 0.5;                    // tier A threshold
  for (const auto& [id, as] : s.activeShips) {
    const auto& dto = as.dto;
    ss::Vec2 off = dto.miningLocationId ? mining_float(dto.shipId, now) : ss::Vec2{};
    amis::Vec2f c = cam.world_to_screen({as.shown.x+off.x, as.shown.y+off.y});
    amis::Color col = dto.ownerId == me ? rgba(0x54c8ff) : rgba(0xff6b6b);
    if (!dto.alive) { amis::render_frame_draw_circle(rf, c, 5, rgba(0x442222, 0.5f)); continue; }
    if (dto.shield > 0 && dto.maxShield > 0)         // shield ring
      amis::render_frame_draw_circle_outline(rf, c, detailed?22.f:12.f, 1.5f,
        rgba(0x54c8ff, 0.12f + 0.3f*(float)(dto.shield/dto.maxShield)));
    const ss::ShipBlueprint* bp = s.blueprintFor(dto.shipId);  // cached (003 §8)
    if (detailed && bp) draw_ship_detailed(rf, c, -dto.heading, *bp, col);          // tier A
    else if (cam.zoom > 0.06) draw_chevron(rf, c, -dto.heading,                     // tier B: silhouette
                std::max(5.f, (float)(9*std::min(1.0, cam.zoom*3))), col);
    else draw_chevron(rf, c, -dto.heading, 5.f, col);                               // tier C: fleet marker glyph
  }
}
```

> LOD tiers (locked, from scene.ts):
> - **A detailed** (`zoom > 0.5`): hull silhouette triangle + per-room grid quads
>   colored by module kind + shield ring. Needs the cached blueprint/rooms.
> - **B silhouette** (`0.06 < zoom ≤ 0.5`): oriented chevron sized `max(5, 9*min(1,
>   zoom*3))`.
> - **C fleet marker** (`zoom ≤ 0.06`): a single small glyph (min-size chevron /
>   dot). On the map, individual ships collapse into the fleet chevron (§4.7).
>
> Heading `ang` is negated at draw (`-dto.heading`) because of the camera Y flip;
> if §1 drops the flip, drop the negation too. Verify with a moving-ship
> screenshot in 012.

`draw_ship_detailed` (port of `drawShipDetailed`): a `cell=10`px grid, hull
triangle, one quad per room. Room fill from `room_color(kind)` (port the switch;
disabled/destroyed rooms dim to `0x552222` / alpha 0.4). Rooms rotate with the
ship the same way the chevron does. Blueprint dimensions come from the cached
`ShipBlueprint` (`width`/`height` in cells).

---

## 6. Fog of war (inverse-masked sensor bubbles)

`renderFog()`: a dark veil (`0x02040a`, α 0.5) covers the whole screen **except**
the player's sensor bubbles (own fleets by `sensorRange`, owned planets by
`PLANET_SENSOR_RANGE`, owned stations by `STATION.sensorRange`). PixiJS did this
with an **inverse mask**: veil rect masked by the union of bubble circles, inverted.

amis has `render_frame_set_mask(rf, mask_texture, MaskParams)` and `MaskParams`
carries `inverted` (`amis.h` lines 687–693). Two routes:

### 6a. Preferred: build a mask texture, apply inverted (screen space)

1. Once (or on resize) create an offscreen `FrameBuffer* fogMask =
   frame_buffer_create(arena, W, H, TEXTURE_FILTER_LINEAR)`.
2. Each frame: clear it transparent, render **white filled circles** at each
   sensor bubble (screen-space center via `world_to_screen`, radius
   `range*zoom`) into it with a scratch `RenderFrame`.
3. In the main frame: `render_frame_set_mask(rf, frame_buffer_get_texture(fogMask),
   { .channel = MASK_CHANNEL_ALPHA, .inverted = true })`, then draw the full-screen
   veil quad, then `render_frame_clear_mask(rf)`. Inverted alpha mask ⇒ veil shows
   where the mask is empty (unsensed) and is punched out inside bubbles.

```cpp
void render_fog(amis::RenderFrame* rf, const Store& s, const ss::Camera& cam) {
  if (!s.showFog) return;
  const auto* snap = s.snapshot(); if (!snap) return;
  const std::string& me = s.playerId;

  // (a) paint bubbles into the mask FB (scratch frame)
  amis::frame_buffer_clear_color(s.fogMaskFb, {0,0,0,0});
  auto* mrf = amis::render_frame_create();
  auto bubble = [&](ss::Vec2 w, double range){
    amis::Vec2f c = cam.world_to_screen(w);
    amis::render_frame_draw_circle(mrf, c, (float)(range*cam.zoom), rgba(0xffffff,1.f));
  };
  for (const auto& f : snap->fleets) if (f.ownerId==me && f.sensorRange>0) bubble(s.fleetPosition(f), f.sensorRange);
  for (const auto& p : snap->planets) if (p.ownerId==me) bubble(p.position, ss::cfg::PLANET_SENSOR_RANGE);
  for (const auto& st : snap->stations) if (st.ownerId==me) bubble(st.position, ss::cfg::STATION.sensorRange);
  amis::render_frame_render(mrf, s.fogMaskFb);
  amis::render_frame_destroy(mrf);

  // (b) apply inverted mask, draw veil, clear mask (all screen space)
  amis::MaskParams mp{}; mp.channel = amis::MASK_CHANNEL_ALPHA; mp.inverted = true;
  amis::render_frame_set_mask(rf, amis::frame_buffer_get_texture(s.fogMaskFb), mp);
  amis::render_frame_draw_quad(rf, {0,0}, {(float)cam.viewW,(float)cam.viewH}, rgba(0x02040a, 0.5f));
  amis::render_frame_clear_mask(rf);
}
```

> Confirm in `amis.h`/engine behavior: (1) whether `MaskParams.inverted` inverts
> the *coverage* (fragments kept where mask alpha < threshold) as assumed here —
> if it inverts the other way, drop `inverted` and instead punch holes; (2)
> whether the mask texture samples in screen UVs (leave `region` = {} to use
> content UVs). If masking can't do inverse-of-veil directly, fall back to 6b.

### 6b. Fallback: framebuffer punch-out (stencil or blend)

Render the veil into `fogFb` (full quad), then draw the bubble circles into the
**same** `fogFb` with `BlendMode::Premultiplied`/a subtractive setup or the stencil
API (`render_frame_stencil_mask_begin/end`, `stencil_set_test`) to carve holes,
then composite `fogFb`'s texture over the scene. Equivalent result; more calls.
Choose 6a if `MaskParams.inverted` behaves as described; else 6b via stencil.

Debug overlay (`renderDebug`, showDebug gate): sensor/engagement rings + status
labels + anchor crosshairs at fleet centroids. Screen-space, straightforward port.

---

## 7. Wiring into the scene render callback

Follow tower-d's `scene_game_render`: clear an FB, create a `RenderFrame`, run
`scene_render`, `render_frame_render(rf, fb)`, destroy, then blit the FB texture to
`scene_render_target()` (so scene transitions work). Or, for a single-scene client,
render straight to `back_buffer()`. The UI pass (step 011, Clay) draws into the
same or a following `RenderFrame` after the world. Keep the world and UI in separate
`render_frame_set_view_matrix` states (world = camera matrix; UI = identity/screen).

---

## 8. Done when

- Connected client shows: parallax starfield, planets/fleets/resources/stations/
  debris, own sensor rings, move lines + anchor crosshairs, fleet chevrons with
  count labels — matching the PixiJS build's layout.
- Zooming crosses the two LOD thresholds (0.5, 0.06) with the same detailed →
  silhouette → fleet-marker transitions; detailed ships show the room grid +
  shield ring from the **cached** blueprint (no blueprint on the stream).
- Projectiles (laser streak / cannon tracer), mining + unload beams, lock lines,
  and 550ms explosions animate identically.
- Fog veil darkens unsensed space and clears inside own sensor bubbles; the clear
  region tracks moving fleets.
- Pan (drag), `zoom_at` (wheel), and `center_on` (H key / locate) behave as in the
  Pixi build after the Y-flip sign is settled; `screen_to_world(world_to_screen(w))
  ≈ w` round-trips (unit test).
- 012 parity: a screenshot at a fixed camera + fixed `GameState` matches the TS
  client within tolerance.

## 9. Unresolved questions

- Y-flip: match PixiJS look (flip, as written) or go Y-up (north=up, drop
  negations)? Lock before 012 screenshot-diff. Default: flip (match Pixi).
- View-matrix vs manual `world_to_screen`: use matrix for world layers, manual for
  px-clamped sizes? Confirm `Camera2D` handedness + whether its zoom/offset match
  our formula (round-trip test).
- `MaskParams.inverted` semantics — does it keep fragments where mask α<threshold
  (needed for veil)? If not, use stencil punch-out (6b). Confirm in amis.
- Label rendering: draw in screen space each frame (crisp, recommended) vs world
  space (scales, blurs)? Default screen space; needs the shared `Font*` from 008.
- Additive blend for explosions/beams — nicer glow but confirm `BlendMode::Additive`
  interacts correctly with the veil/mask pass ordering.
- Per-ship detailed LOD cost at `zoom>0.5` with many ships — cap detailed draws by
  on-screen count, or accept? Default accept; revisit if frame time spikes.
- Fog mask FB must resize with the window (`window_resized()`); confirm recreate vs
  `frame_buffer` resize API.
</content>
</invoke>
