import type { BaseStateMessage } from "../worker/sim.worker";

const SKEW = 0.9; // horizontal shift of the isotherms per unit of normalised height

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function line(
  g: CanvasRenderingContext2D,
  pts: [number, number][],
  color: string,
  width = 1.5,
  dash: number[] = []
): void {
  if (pts.length < 2) return;
  g.save();
  g.strokeStyle = color;
  g.lineWidth = width;
  g.setLineDash(dash);
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
  g.stroke();
  g.restore();
}

/**
 * Skew-T-style thermodynamic diagram plus a hodograph. Both are drawn straight
 * to a 2D canvas: no plotting library, no images.
 */
export class SoundingPlot {
  private g: CanvasRenderingContext2D;
  private base: BaseStateMessage | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    this.g = ctx;
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  setBase(b: BaseStateMessage): void {
    this.base = b;
    this.draw();
  }

  draw(): void {
    const dpr = Math.min(devicePixelRatio, 2);
    const w = this.canvas.clientWidth || 320;
    const h = this.canvas.clientHeight || 420;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (!this.base) return;

    const hodoH = Math.min(150, h * 0.36);
    const skew: Box = { x: 38, y: 10, w: w - 78, h: h - hodoH - 36 };
    const hodo: Box = {
      x: 38,
      y: skew.y + skew.h + 24,
      w: Math.min(hodoH, w - 78),
      h: hodoH,
    };
    this.drawSkewT(skew);
    this.drawHodograph(hodo);
  }

  private drawSkewT(box: Box): void {
    const g = this.g;
    const b = this.base!;
    const pSfc = b.p[0];
    const pTop = Math.max(b.p[b.p.length - 1], 7000);
    const tMin = -95;
    const tMax = 45;

    const yOf = (p: number) =>
      box.y +
      box.h * (Math.log(pSfc) - Math.log(p)) / (Math.log(pSfc) - Math.log(pTop));
    const xOf = (tC: number, p: number) => {
      const yn = (yOf(p) - box.y) / box.h;
      return (
        box.x + ((tC - tMin) / (tMax - tMin)) * box.w + SKEW * yn * box.w * 0.42
      );
    };

    g.save();
    g.beginPath();
    g.rect(box.x, box.y, box.w, box.h);
    g.clip();

    g.fillStyle = "#0c1119";
    g.fillRect(box.x, box.y, box.w, box.h);

    // Skewed isotherms.
    for (let t = -120; t <= 60; t += 10) {
      const pts: [number, number][] = [];
      for (let p = pSfc; p >= pTop; p -= (pSfc - pTop) / 24)
        pts.push([xOf(t, p), yOf(p)]);
      line(g, pts, t === 0 ? "#3f5a7d" : "#1e2a3a", t === 0 ? 1.4 : 1);
    }
    // Isobars.
    for (const p of [100000, 92500, 85000, 70000, 50000, 40000, 30000, 25000, 20000, 15000, 10000]) {
      if (p > pSfc || p < pTop) continue;
      const y = yOf(p);
      line(g, [[box.x, y], [box.x + box.w, y]], "#1b2533", 1);
    }

    // CAPE / CIN shading between the parcel and the environment.
    const envPts: [number, number][] = [];
    const parPts: [number, number][] = [];
    for (let k = 0; k < b.z.length; k++) {
      envPts.push([xOf(b.T[k] - 273.15, b.p[k]), yOf(b.p[k])]);
      if (isFinite(b.parcelT[k]))
        parPts.push([xOf(b.parcelT[k] - 273.15, b.p[k]), yOf(b.p[k])]);
    }
    for (let k = 1; k < Math.min(envPts.length, parPts.length); k++) {
      const warmer = b.parcelT[k] > b.T[k];
      g.fillStyle = warmer ? "rgba(224,78,62,0.22)" : "rgba(86,136,214,0.18)";
      g.beginPath();
      g.moveTo(envPts[k - 1][0], envPts[k - 1][1]);
      g.lineTo(envPts[k][0], envPts[k][1]);
      g.lineTo(parPts[k][0], parPts[k][1]);
      g.lineTo(parPts[k - 1][0], parPts[k - 1][1]);
      g.closePath();
      g.fill();
    }

    const tdPts: [number, number][] = b.z.map((_, k) => [
      xOf(b.Td[k] - 273.15, b.p[k]),
      yOf(b.p[k]),
    ]);
    line(g, parPts, "#e8edf5", 1.4, [5, 4]);
    line(g, tdPts, "#49c98a", 2.2);
    line(g, envPts, "#e8584a", 2.2);

    // LCL / LFC / EL markers.
    const mark = (z: number, color: string) => {
      if (!isFinite(z)) return;
      let k = 0;
      while (k < b.z.length - 1 && b.z[k] < z) k++;
      const y = yOf(b.p[k]);
      line(g, [[box.x, y], [box.x + box.w, y]], color, 1, [2, 3]);
    };
    mark(b.lclZ, "#49c98a");
    mark(b.lfcZ, "#e8a33d");
    mark(b.elZ, "#8a6fd0");
    g.restore();

    g.strokeStyle = "#2b3a4f";
    g.lineWidth = 1;
    g.strokeRect(box.x, box.y, box.w, box.h);

    // Axes.
    g.fillStyle = "#7f8ea6";
    g.font = "10px ui-monospace, monospace";
    g.textAlign = "right";
    for (const p of [100000, 85000, 70000, 50000, 30000, 20000, 10000]) {
      if (p > pSfc || p < pTop) continue;
      g.fillText(String(p / 100), box.x - 5, yOf(p) + 3);
    }
    g.textAlign = "left";
    for (let k = 0; k < b.z.length; k += Math.ceil(b.z.length / 8)) {
      g.fillText(
        `${(b.z[k] / 1000).toFixed(0)}km`,
        box.x + box.w + 4,
        yOf(b.p[k]) + 3
      );
    }
    g.textAlign = "center";
    for (let t = -80; t <= 40; t += 20)
      g.fillText(String(t), xOf(t, pSfc), box.y + box.h + 12);
    g.textAlign = "left";
    g.fillStyle = "#9fb0c8";
    g.fillText("hPa", 6, box.y + 9);
  }

  private drawHodograph(box: Box): void {
    const g = this.g;
    const b = this.base!;
    let rmax = 10;
    for (let k = 0; k < b.z.length && b.z[k] <= 12000; k++)
      rmax = Math.max(rmax, Math.abs(b.u[k]), Math.abs(b.v[k]));
    rmax = Math.ceil((rmax * 1.15) / 10) * 10;
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const r = Math.min(box.w, box.h) / 2;
    const sx = (u: number) => cx + (u / rmax) * r;
    const sy = (v: number) => cy - (v / rmax) * r;

    g.save();
    g.fillStyle = "#0c1119";
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fill();
    for (let ring = 10; ring <= rmax; ring += 10) {
      g.strokeStyle = "#1e2a3a";
      g.lineWidth = 1;
      g.beginPath();
      g.arc(cx, cy, (ring / rmax) * r, 0, Math.PI * 2);
      g.stroke();
    }
    line(g, [[cx - r, cy], [cx + r, cy]], "#243245", 1);
    line(g, [[cx, cy - r], [cx, cy + r]], "#243245", 1);

    // Hodograph coloured by height band.
    const bands: [number, number, string][] = [
      [0, 1000, "#e8584a"],
      [1000, 3000, "#e8a33d"],
      [3000, 6000, "#49c98a"],
      [6000, 12000, "#5a8ed6"],
    ];
    for (const [z0, z1, color] of bands) {
      const pts: [number, number][] = [];
      for (let k = 0; k < b.z.length; k++)
        if (b.z[k] >= z0 && b.z[k] <= z1) pts.push([sx(b.u[k]), sy(b.v[k])]);
      line(g, pts, color, 2.4);
    }
    g.restore();

    g.fillStyle = "#7f8ea6";
    g.font = "10px ui-monospace, monospace";
    g.textAlign = "left";
    g.fillText(`hodograph  ring = 10 m/s`, box.x + box.w + 10, box.y + 12);
    g.fillText(`0-1 km`, box.x + box.w + 10, box.y + 30);
    g.fillStyle = "#e8584a";
    g.fillRect(box.x + box.w + 62, box.y + 23, 18, 3);
    g.fillStyle = "#7f8ea6";
    g.fillText(`1-3 km`, box.x + box.w + 10, box.y + 44);
    g.fillStyle = "#e8a33d";
    g.fillRect(box.x + box.w + 62, box.y + 37, 18, 3);
    g.fillStyle = "#7f8ea6";
    g.fillText(`3-6 km`, box.x + box.w + 10, box.y + 58);
    g.fillStyle = "#49c98a";
    g.fillRect(box.x + box.w + 62, box.y + 51, 18, 3);
    g.fillStyle = "#7f8ea6";
    g.fillText(`6-12 km`, box.x + box.w + 10, box.y + 72);
    g.fillStyle = "#5a8ed6";
    g.fillRect(box.x + box.w + 62, box.y + 65, 18, 3);
  }
}
