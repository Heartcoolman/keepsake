/** PUBLIC STUB — the real GPGPU particle engine (Three.js spring/curl physics,
 *  depth-of-field bokeh, sand-burst, text dissolve, ambience systems) lives in the
 *  private core module. This stub keeps the exact public API and renders the photo
 *  as a static cover-fit image on a 2D canvas, so the app remains fully usable —
 *  just without the particle effects. */
import type { DepthLayers } from '../lib/depth';

export type Ambience = 'none' | 'dust' | 'rain' | 'snow';

type Uniform = { value: number };

export class ParticleEngine {
  readonly phys: { uSpring: Uniform; uDamping: Uniform; uTurb: Uniform; uBurst: Uniform } = {
    uSpring: { value: 0 },
    uDamping: { value: 0 },
    uTurb: { value: 0 },
    uBurst: { value: 0 },
  };

  readonly uniforms: {
    uProgress: Uniform; uGlobalAlpha: Uniform; uPointScale: Uniform;
    uMouseRadius: Uniform; uDepth: Uniform; uFocusRadius: Uniform; uFocusStrength: Uniform;
  } = {
    uProgress: { value: 1 },
    uGlobalAlpha: { value: 1 },
    uPointScale: { value: 0 },
    uMouseRadius: { value: 0 },
    uDepth: { value: 0 },
    uFocusRadius: { value: 0 },
    uFocusStrength: { value: 0 },
  };

  wheelZoomEnabled = false;

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private bitmap: ImageBitmap | null = null;
  private dimmed = false;
  private readonly onResize = () => this.redraw();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d canvas unavailable');
    this.ctx = ctx;
    window.addEventListener('resize', this.onResize);
  }

  private redraw(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.clearRect(0, 0, w, h);
    if (!this.bitmap) return;
    const scale = Math.max(w / this.bitmap.width, h / this.bitmap.height);
    const dw = this.bitmap.width * scale;
    const dh = this.bitmap.height * scale;
    this.ctx.globalAlpha = this.dimmed ? 0.35 : 1;
    this.ctx.drawImage(this.bitmap, (w - dw) / 2, (h - dh) / 2, dw, dh);
    this.ctx.globalAlpha = 1;
  }

  async setImage(blob: Blob, opts: { atTarget?: boolean } = {}): Promise<void> {
    void opts;
    this.bitmap?.close();
    this.bitmap = await createImageBitmap(blob);
    this.redraw();
  }

  clearImage(): void {
    this.bitmap?.close();
    this.bitmap = null;
    this.redraw();
  }

  applyDepthMap(map: { data: Float32Array; width: number; height: number }): void { void map; }
  applyLayers(l: DepthLayers): void { void l; }
  fallbackDepth(): void {}

  assemble(onDone?: () => void): void { if (onDone) queueMicrotask(onDone); }
  sandify(onDone?: () => void): void { if (onDone) queueMicrotask(onDone); }
  condense(): void {}

  dim(): void { this.dimmed = true; this.redraw(); }
  undim(): void { this.dimmed = false; this.redraw(); }
  hidePhoto(): void {}

  setAmbience(mode: Ambience): void { void mode; }
  setDust(visible: boolean): void { void visible; }
  pulse(): void {}
  dissolveText(lines: string[]): void { void lines; }
  resetZoom(): void {}
  pause(): void {}
  resume(): void {}

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    this.bitmap?.close();
    this.bitmap = null;
  }
}
