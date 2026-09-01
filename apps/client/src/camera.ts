// World camera (DESIGN §9.2). World coordinates stay independent of screen space.
// Pan by pointer drag; zoom around cursor with the wheel; clamp zoom.

export class Camera {
  x = 0; // world coordinate at screen center
  y = 0;
  zoom = 0.12;
  readonly minZoom = 0.02;
  readonly maxZoom = 2.5;

  constructor(
    public viewWidth: number,
    public viewHeight: number,
  ) {}

  resize(w: number, h: number): void {
    this.viewWidth = w;
    this.viewHeight = h;
  }

  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return {
      x: (wx - this.x) * this.zoom + this.viewWidth / 2,
      y: (wy - this.y) * this.zoom + this.viewHeight / 2,
    };
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.viewWidth / 2) / this.zoom + this.x,
      y: (sy - this.viewHeight / 2) / this.zoom + this.y,
    };
  }

  panByScreen(dxScreen: number, dyScreen: number): void {
    this.x -= dxScreen / this.zoom;
    this.y -= dyScreen / this.zoom;
  }

  /** Zoom keeping the world point under the cursor fixed on screen. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.screenToWorld(sx, sy);
    this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, this.zoom * factor));
    const after = this.screenToWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
  }

  centerOn(wx: number, wy: number): void {
    this.x = wx;
    this.y = wy;
  }
}
