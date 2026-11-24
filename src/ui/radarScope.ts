import { RADAR_SCALE, DBZ_FLOOR, describeDbz, cm1Color } from "../core/radar";

export type ScopeMode = "plan" | "section";

export interface ScopeFrame {
  nx: number;
  ny: number;
  nz: number;
  dx: number; // m
  dy: number;
  dz: number;
  sectionJ: number;
  maxDbz: number;
  echoTopMax: number; // m
  /** Column-maximum reflectivity, nx*ny. */
  composite: Float32Array;
  /** Echo top height in m, nx*ny. */
  tops: Float32Array;
  /** Vertical section through sectionJ, nx*nz. */
  section: Float32Array;
}

/**
 * A radar scope: what this storm would look like on a weather radar.
 *
 * Deliberately drawn as hard-edged cells with no interpolation and no
 * anti-aliasing. A radar product is a grid of discrete gates in banded
 * colours, and smoothing one is a lie about the resolution.
 */
export class RadarScope {
  private g: CanvasRenderingContext2D;
  private frame: ScopeFrame | null = null;
  mode: ScopeMode = "plan";
  /** Operational banded table, or the continuous rainbow CM1 is plotted with. */
  palette: "nws" | "cm1" = "nws";

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    this.g = ctx;
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  setFrame(f: ScopeFrame): void {
    this.frame = f;
    this.draw();
  }

  setMode(m: ScopeMode): void {
    this.mode = m;
    this.draw();
  }

  setPalette(p: "nws" | "cm1"): void {
    if (this.palette === p) return;
    this.palette = p;
    this.draw();
  }

  private colorOf(dbz: number): string | null {
    if (this.palette === "cm1") {
      if (dbz < -10) return null;
      const c = cm1Color(dbz);
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
    if (dbz < DBZ_FLOOR) return null;
    let pick = RADAR_SCALE[0];
    for (const s of RADAR_SCALE) if (dbz >= s.dbz) pick = s;
    return `rgb(${pick.rgb[0]},${pick.rgb[1]},${pick.rgb[2]})`;
  }

  draw(): void {
    const dpr = Math.min(devicePixelRatio, 2);
    const w = this.canvas.clientWidth || 300;
    const h = this.canvas.clientHeight || 300;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, w, h);
    g.fillStyle = "#05070a";
    g.fillRect(0, 0, w, h);

    const f = this.frame;
    const barH = 26;
    const headH = 18;
    const plotH = h - barH - headH - 6;

    if (!f) {
      g.fillStyle = "#5c6b80";
      g.font = "11px ui-monospace, monospace";
      g.textAlign = "center";
      g.fillText("no echo", w / 2, h / 2);
      return;
    }

    if (this.mode === "plan") this.drawPlan(f, 0, headH, w, plotH);
    else this.drawSection(f, 0, headH, w, plotH);

    this.drawHeader(f, w, headH);
    this.drawColorBar(0, h - barH + 4, w, barH - 8);
  }

  private drawHeader(f: ScopeFrame, w: number, h: number): void {
    const g = this.g;
    g.fillStyle = "#9fb0c8";
    g.font = "10.5px ui-monospace, monospace";
    g.textAlign = "left";
    const max = f.maxDbz < DBZ_FLOOR ? "—" : `${f.maxDbz.toFixed(0)} dBZ`;
    g.fillText(
      this.mode === "plan" ? `composite  max ${max}` : `vertical section  max ${max}`,
      6,
      h - 5
    );
    g.textAlign = "right";
    g.fillStyle = "#7f8ea6";
    g.fillText(
      f.echoTopMax > 0 ? `echo top ${(f.echoTopMax / 1000).toFixed(1)} km` : "",
      w - 6,
      h - 5
    );
  }

  /** Plan view: column-maximum reflectivity, with range rings. */
  private drawPlan(f: ScopeFrame, x0: number, y0: number, w: number, h: number): void {
    const g = this.g;
    const Lx = f.nx * f.dx;
    const Ly = f.ny * f.dy;
    const scale = Math.min(w / Lx, h / Ly) * 0.94;
    const pw = Lx * scale;
    const ph = Ly * scale;
    const ox = x0 + (w - pw) / 2;
    const oy = y0 + (h - ph) / 2;
    const cw = pw / f.nx;
    const ch = ph / f.ny;

    g.fillStyle = "#070a0f";
    g.fillRect(ox, oy, pw, ph);

    for (let j = 0; j < f.ny; j++) {
      for (let i = 0; i < f.nx; i++) {
        const c = this.colorOf(f.composite[i + f.nx * j]);
        if (!c) continue;
        g.fillStyle = c;
        // North is up: the model's +y runs up the screen.
        g.fillRect(
          Math.floor(ox + i * cw),
          Math.floor(oy + (f.ny - 1 - j) * ch),
          Math.ceil(cw),
          Math.ceil(ch)
        );
      }
    }

    // Range rings every 10 km from the centre of the domain.
    const cx = ox + pw / 2;
    const cy = oy + ph / 2;
    g.strokeStyle = "rgba(120,150,185,0.35)";
    g.lineWidth = 1;
    g.setLineDash([2, 3]);
    for (let r = 10000; r <= Math.max(Lx, Ly); r += 10000) {
      g.beginPath();
      g.arc(cx, cy, r * scale, 0, Math.PI * 2);
      g.stroke();
    }
    g.setLineDash([]);
    g.beginPath();
    g.moveTo(cx - 5, cy);
    g.lineTo(cx + 5, cy);
    g.moveTo(cx, cy - 5);
    g.lineTo(cx, cy + 5);
    g.stroke();

    g.strokeStyle = "#1f2a3a";
    g.strokeRect(ox, oy, pw, ph);

    g.fillStyle = "#6b7c93";
    g.font = "9.5px ui-monospace, monospace";
    g.textAlign = "left";
    g.fillText("N", cx + 3, oy + 10);
    g.fillText(`rings 10 km · ${(Lx / 1000).toFixed(0)} km across`, ox + 3, oy + ph - 4);
  }

  /** Vertical section through the strongest echo, like a radar RHI scan. */
  private drawSection(f: ScopeFrame, x0: number, y0: number, w: number, h: number): void {
    const g = this.g;
    const pad = 26;
    const pw = w - pad - 6;
    const ph = h - 16;
    const ox = x0 + pad;
    const oy = y0 + 4;
    const cw = pw / f.nx;
    const ch = ph / f.nz;

    g.fillStyle = "#070a0f";
    g.fillRect(ox, oy, pw, ph);

    for (let k = 0; k < f.nz; k++) {
      for (let i = 0; i < f.nx; i++) {
        const c = this.colorOf(f.section[i + f.nx * k]);
        if (!c) continue;
        g.fillStyle = c;
        g.fillRect(
          Math.floor(ox + i * cw),
          Math.floor(oy + (f.nz - 1 - k) * ch),
          Math.ceil(cw),
          Math.ceil(ch)
        );
      }
    }

    // Height axis in kilometres.
    g.strokeStyle = "rgba(120,150,185,0.25)";
    g.fillStyle = "#6b7c93";
    g.font = "9.5px ui-monospace, monospace";
    g.textAlign = "right";
    const topKm = (f.nz * f.dz) / 1000;
    for (let km = 0; km <= topKm; km += topKm > 12 ? 4 : 2) {
      const y = oy + ph - (km / topKm) * ph;
      g.beginPath();
      g.moveTo(ox, y);
      g.lineTo(ox + pw, y);
      g.stroke();
      g.fillText(String(km), ox - 4, y + 3);
    }
    g.textAlign = "left";
    g.fillText("km", 2, oy + 9);
    g.strokeStyle = "#1f2a3a";
    g.strokeRect(ox, oy, pw, ph);
    g.textAlign = "center";
    g.fillText(
      `${(f.nx * f.dx / 1000).toFixed(0)} km · cut through the strongest echo`,
      ox + pw / 2,
      oy + ph + 11
    );
  }

  private drawColorBar(x0: number, y0: number, w: number, h: number): void {
    const g = this.g;
    g.font = "8.5px ui-monospace, monospace";
    g.textAlign = "center";
    if (this.palette === "cm1") {
      // Continuous ramp from -10 to 80 dBZ.
      const bw = w - 12;
      for (let px = 0; px < bw; px++) {
        const d = -10 + (px / bw) * 90;
        const c = cm1Color(d);
        g.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
        g.fillRect(6 + px, y0, 1, h - 10);
      }
      g.fillStyle = "#7f8ea6";
      for (const d of [-10, 10, 30, 50, 70]) {
        const px = ((d + 10) / 90) * bw;
        g.fillText(String(d), 6 + px, y0 + h - 1);
      }
      void x0;
      return;
    }
    const stops = RADAR_SCALE;
    const bw = (w - 12) / stops.length;
    for (let i = 0; i < stops.length; i++) {
      const s = stops[i];
      g.fillStyle = `rgb(${s.rgb[0]},${s.rgb[1]},${s.rgb[2]})`;
      g.fillRect(6 + i * bw, y0, Math.ceil(bw), h - 10);
      if (i % 2 === 0) {
        g.fillStyle = "#7f8ea6";
        g.fillText(String(s.dbz), 6 + i * bw + bw / 2, y0 + h - 1);
      }
    }
    void x0;
  }

  /** One-line summary for the caption under the scope. */
  caption(): string {
    const f = this.frame;
    if (!f || f.maxDbz < DBZ_FLOOR) return "No echo — the storm is not raining yet.";
    return `${f.maxDbz.toFixed(0)} dBZ — ${describeDbz(f.maxDbz)}.`;
  }
}
