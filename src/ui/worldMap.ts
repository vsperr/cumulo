import { feature } from "topojson-client";
import topology from "world-atlas/countries-110m.json";

/**
 * A clickable world map drawn as plain polylines on a 2D canvas — coastlines
 * and borders from Natural Earth, no raster tiles, no images, nothing fetched
 * at run time. Scroll to zoom, drag to pan, click to pick a point.
 */

type Ring = [number, number][];

function extractRings(): Ring[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const topo = topology as any;
  const fc = feature(topo, topo.objects.countries) as unknown as {
    features: { geometry: { type: string; coordinates: unknown } | null }[];
  };
  const rings: Ring[] = [];
  const push = (poly: number[][][]) => {
    for (const ring of poly) rings.push(ring as Ring);
  };
  for (const f of fc.features) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === "Polygon") push(g.coordinates as number[][][]);
    else if (g.type === "MultiPolygon")
      for (const poly of g.coordinates as number[][][][]) push(poly);
  }
  return rings;
}

const RINGS = extractRings();

export interface MapPoint {
  lat: number;
  lon: number;
}

export class WorldMap {
  private g: CanvasRenderingContext2D;
  private lonCenter = 10;
  private latCenter = 45;
  private k = 1.6; // pixels per degree
  private dragging = false;
  private dragMoved = 0;
  private last: [number, number] = [0, 0];
  private point: MapPoint | null = null;
  private hover: MapPoint | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private onPick: (p: MapPoint) => void
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    this.g = ctx;
    new ResizeObserver(() => this.draw()).observe(canvas);
    this.bind();
    this.draw();
  }

  setPoint(p: MapPoint, centre = false): void {
    this.point = p;
    if (centre) {
      this.lonCenter = p.lon;
      this.latCenter = p.lat;
    }
    this.draw();
  }

  private size(): [number, number] {
    return [this.canvas.clientWidth || 300, this.canvas.clientHeight || 180];
  }

  private project(lon: number, lat: number): [number, number] {
    const [w, h] = this.size();
    let dl = lon - this.lonCenter;
    while (dl > 180) dl -= 360;
    while (dl < -180) dl += 360;
    return [w / 2 + dl * this.k, h / 2 - (lat - this.latCenter) * this.k];
  }

  private unproject(x: number, y: number): MapPoint {
    const [w, h] = this.size();
    let lon = this.lonCenter + (x - w / 2) / this.k;
    while (lon > 180) lon -= 360;
    while (lon < -180) lon += 360;
    const lat = Math.max(
      -89.9,
      Math.min(89.9, this.latCenter - (y - h / 2) / this.k)
    );
    return { lat, lon };
  }

  private bind(): void {
    const c = this.canvas;
    const pos = (e: MouseEvent): [number, number] => {
      const r = c.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    c.addEventListener("mousedown", (e) => {
      this.dragging = true;
      this.dragMoved = 0;
      this.last = pos(e);
    });
    window.addEventListener("mouseup", () => (this.dragging = false));
    c.addEventListener("mousemove", (e) => {
      const p = pos(e);
      this.hover = this.unproject(p[0], p[1]);
      if (this.dragging) {
        const dx = p[0] - this.last[0];
        const dy = p[1] - this.last[1];
        this.dragMoved += Math.abs(dx) + Math.abs(dy);
        this.lonCenter -= dx / this.k;
        this.latCenter += dy / this.k;
        this.latCenter = Math.max(-85, Math.min(85, this.latCenter));
        this.last = p;
      }
      this.draw();
    });
    c.addEventListener("mouseleave", () => {
      this.hover = null;
      this.draw();
    });
    c.addEventListener("click", (e) => {
      if (this.dragMoved > 4) return; // that was a pan, not a pick
      const [x, y] = pos(e);
      const p = this.unproject(x, y);
      this.point = p;
      this.draw();
      this.onPick(p);
    });
    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const [x, y] = pos(e);
        const before = this.unproject(x, y);
        const f = Math.exp(-e.deltaY * 0.0015);
        this.k = Math.max(0.35, Math.min(60, this.k * f));
        const after = this.unproject(x, y);
        this.lonCenter += before.lon - after.lon;
        this.latCenter += before.lat - after.lat;
        this.draw();
      },
      { passive: false }
    );
  }

  draw(): void {
    const dpr = Math.min(devicePixelRatio, 2);
    const [w, h] = this.size();
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    g.fillStyle = "#0a0e15";
    g.fillRect(0, 0, w, h);

    // Graticule, spaced to the zoom level.
    const spacing = this.k > 14 ? 1 : this.k > 6 ? 5 : this.k > 2 ? 10 : 30;
    g.strokeStyle = "#151e2b";
    g.lineWidth = 1;
    g.beginPath();
    for (let lon = -180; lon <= 180; lon += spacing) {
      const [x] = this.project(lon, 0);
      if (x < -2 || x > w + 2) continue;
      g.moveTo(x, 0);
      g.lineTo(x, h);
    }
    for (let lat = -90; lat <= 90; lat += spacing) {
      const [, y] = this.project(0, lat);
      if (y < -2 || y > h + 2) continue;
      g.moveTo(0, y);
      g.lineTo(w, y);
    }
    g.stroke();

    // Equator picked out.
    g.strokeStyle = "#24364d";
    g.beginPath();
    const [, yEq] = this.project(0, 0);
    g.moveTo(0, yEq);
    g.lineTo(w, yEq);
    g.stroke();

    // Coastlines and borders.
    g.strokeStyle = "#49698f";
    g.lineWidth = 1;
    g.beginPath();
    for (const ring of RINGS) {
      let started = false;
      let prevX = 0;
      for (const [lon, lat] of ring) {
        const [x, y] = this.project(lon, lat);
        // Avoid a stroke straight across the map at the antimeridian.
        if (started && Math.abs(x - prevX) > w * 0.6) {
          started = false;
        }
        if (!started) {
          g.moveTo(x, y);
          started = true;
        } else {
          g.lineTo(x, y);
        }
        prevX = x;
      }
    }
    g.stroke();

    // The chosen point.
    if (this.point) {
      const [x, y] = this.project(this.point.lon, this.point.lat);
      g.strokeStyle = "#e8a33d";
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(x, y, 6, 0, Math.PI * 2);
      g.moveTo(x - 11, y);
      g.lineTo(x - 2, y);
      g.moveTo(x + 2, y);
      g.lineTo(x + 11, y);
      g.moveTo(x, y - 11);
      g.lineTo(x, y - 2);
      g.moveTo(x, y + 2);
      g.lineTo(x, y + 11);
      g.stroke();
    }

    // Readout.
    const read = this.hover ?? this.point;
    if (read) {
      g.fillStyle = "#7f8ea6";
      g.font = "10px ui-monospace, monospace";
      g.textAlign = "left";
      const ns = read.lat >= 0 ? "N" : "S";
      const ew = read.lon >= 0 ? "E" : "W";
      g.fillText(
        `${Math.abs(read.lat).toFixed(2)}°${ns}  ${Math.abs(read.lon).toFixed(2)}°${ew}`,
        6,
        h - 6
      );
    }
    g.fillStyle = "#5c6b80";
    g.font = "9.5px ui-sans-serif, system-ui, sans-serif";
    g.textAlign = "right";
    g.fillText("click to pick · scroll to zoom · drag to pan", w - 6, h - 6);
  }
}
