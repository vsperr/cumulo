/**
 * Offline renderer for the animation in the README.
 *
 * It runs the same solver the page runs and ray-marches each frame on the CPU
 * in the CM1 style — a bare grey cloud iso-surface, a reflectivity slice on
 * the ground, a daylight sky. Nothing is screen-recorded, so the animation can
 * be regenerated from source with one command and will look the same every
 * time.
 *
 *   npm run gif            frames into media/frames, then ffmpeg makes the gif
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { defaultConfig } from "../src/core/config";
import { Solver } from "../src/core/solver";
import { reflectivityDbz, cm1Color } from "../src/core/radar";
import { encodePng } from "./png";

const W = Number(process.env.W ?? 480);
const H = Number(process.env.H ?? 270);
const FRAMES = Number(process.env.FRAMES ?? 56);
const START_MIN = Number(process.env.START ?? 7);
const END_MIN = Number(process.env.END ?? 42);
const OUT = "media/frames";

// --- the storm -------------------------------------------------------------
const cfg = defaultConfig();
cfg.grid.nx = 64;
cfg.grid.ny = 64;
// Finer vertical spacing than the browser default: with 400 m levels the
// iso-surface shows visible terracing, and this render is offline anyway.
cfg.grid.nz = 56;
cfg.grid.dx = 500;
cfg.grid.dy = 500;
cfg.grid.dz = 300;
cfg.bubble.noise = 0;
const solver = new Solver(cfg);
const { nx, ny, nz } = solver;
const Lx = nx * cfg.grid.dx;
const Ly = ny * cfg.grid.dy;
const Lz = nz * cfg.grid.dz;

// Box in world units, matching the browser: the longer horizontal side is 2.
const S = 2 / Math.max(Lx, Ly);
const BX = Lx * S;
const BY = Lz * S;
const BZ = Ly * S;

const ISO = 0.05; // g/kg of cloud condensate
const STEPS = 150;

// --- fields for one frame --------------------------------------------------
const cloud = new Float32Array(nx * ny * nz); // qc + qi, g/kg
const groundDbz = new Float32Array(nx * ny);

function grab(): void {
  for (let k = 0; k < nz; k++) {
    const rho = solver.base.rho[k];
    for (let m = 0; m < nx * ny; m++) {
      const i = m + nx * ny * k;
      cloud[i] = (solver.qc[i] + solver.qi[i]) * 1e3;
      if (k === 0) {
        const T =
          (solver.base.theta[0] + solver.thp[i]) *
          (solver.base.pi[0] + solver.pip[i]);
        groundDbz[m] = reflectivityDbz(rho, solver.qr[i], solver.qs[i], solver.qg[i], T);
      }
    }
  }
}

/** Bounding box of the cloud in local coordinates, to skip empty space. */
function cloudBounds(): [number, number, number, number, number, number] | null {
  let i0 = nx, i1 = -1, j0 = ny, j1 = -1, k0 = nz, k1 = -1;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++)
        if (cloud[i + nx * (j + ny * k)] >= ISO) {
          if (i < i0) i0 = i;
          if (i > i1) i1 = i;
          if (j < j0) j0 = j;
          if (j > j1) j1 = j;
          if (k < k0) k0 = k;
          if (k > k1) k1 = k;
        }
  if (i1 < 0) return null;
  const pad = 2;
  return [
    (Math.max(i0 - pad, 0) / nx - 0.5) * BX,
    (Math.min(i1 + 1 + pad, nx) / nx - 0.5) * BX,
    (Math.max(k0 - pad, 0) / nz) * BY,
    (Math.min(k1 + 1 + pad, nz) / nz) * BY,
    (Math.max(j0 - pad, 0) / ny - 0.5) * BZ,
    (Math.min(j1 + 1 + pad, ny) / ny - 0.5) * BZ,
  ];
}

/** Trilinear sample of the cloud field at a local-space point. */
function sampleCloud(x: number, y: number, z: number): number {
  const fx = (x / BX + 0.5) * nx - 0.5;
  const fy = (z / BZ + 0.5) * ny - 0.5;
  const fz = (y / BY) * nz - 0.5;
  const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
  if (i < 0 || j < 0 || k < 0 || i >= nx - 1 || j >= ny - 1 || k >= nz - 1) return 0;
  const tx = fx - i, ty = fy - j, tz = fz - k;
  const at = (ii: number, jj: number, kk: number) => cloud[ii + nx * (jj + ny * kk)];
  const c00 = at(i, j, k) * (1 - tx) + at(i + 1, j, k) * tx;
  const c10 = at(i, j + 1, k) * (1 - tx) + at(i + 1, j + 1, k) * tx;
  const c01 = at(i, j, k + 1) * (1 - tx) + at(i + 1, j, k + 1) * tx;
  const c11 = at(i, j + 1, k + 1) * (1 - tx) + at(i + 1, j + 1, k + 1) * tx;
  const c0 = c00 * (1 - ty) + c10 * ty;
  const c1 = c01 * (1 - ty) + c11 * ty;
  return c0 * (1 - tz) + c1 * tz;
}

function hitBox(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  x0: number, x1: number, y0: number, y1: number, z0: number, z1: number
): [number, number] | null {
  let t0 = -1e9, t1 = 1e9;
  const slab = (o: number, d: number, lo: number, hi: number) => {
    if (Math.abs(d) < 1e-9) return o >= lo && o <= hi;
    const a = (lo - o) / d, b = (hi - o) / d;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
    return true;
  };
  if (!slab(ox, dx, x0, x1) || !slab(oy, dy, y0, y1) || !slab(oz, dz, z0, z1)) return null;
  if (t1 <= Math.max(t0, 0)) return null;
  return [Math.max(t0, 0), t1];
}

// --- render one frame ------------------------------------------------------
const rgb = new Uint8Array(W * H * 3);
const SUN = (() => {
  const az = (135 * Math.PI) / 180, el = (62 * Math.PI) / 180;
  return [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
})();

function renderFrame(azimuth: number): void {
  const bounds = cloudBounds();
  const target = [0, BY * 0.34, 0];
  const dist = 3.6;
  const el = (15 * Math.PI) / 180;
  const cam = [
    target[0] + dist * Math.cos(el) * Math.sin(azimuth),
    target[1] + dist * Math.sin(el),
    target[2] + dist * Math.cos(el) * Math.cos(azimuth),
  ];
  // Camera basis.
  const fwd = [target[0] - cam[0], target[1] - cam[1], target[2] - cam[2]];
  const fl = Math.hypot(fwd[0], fwd[1], fwd[2]);
  fwd[0] /= fl; fwd[1] /= fl; fwd[2] /= fl;
  // right = normalize(fwd x worldUp); getting this sign wrong mirrors the
  // image on both axes, which looks like the ground is in the sky.
  const right = [-fwd[2], 0, fwd[0]];
  const rl = Math.hypot(right[0], right[1], right[2]);
  right[0] /= rl; right[1] /= rl; right[2] /= rl;
  const up = [
    right[1] * fwd[2] - right[2] * fwd[1],
    right[2] * fwd[0] - right[0] * fwd[2],
    right[0] * fwd[1] - right[1] * fwd[0],
  ];
  const tf = Math.tan((34 * Math.PI) / 360);
  const aspect = W / H;

  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const ndcx = ((px + 0.5) / W) * 2 - 1;
      const ndcy = 1 - ((py + 0.5) / H) * 2;
      let dx = fwd[0] + right[0] * ndcx * aspect * tf + up[0] * ndcy * tf;
      let dy = fwd[1] + right[1] * ndcx * aspect * tf + up[1] * ndcy * tf;
      let dz = fwd[2] + right[2] * ndcx * aspect * tf + up[2] * ndcy * tf;
      const dl = Math.hypot(dx, dy, dz);
      dx /= dl; dy /= dl; dz /= dl;

      // Sky.
      const sky = Math.max(0, Math.min(1, dy * 0.5 + 0.5));
      let r = 0.42 + (0.22 - 0.42) * sky;
      let g = 0.68 + (0.56 - 0.68) * sky;
      let b = 0.85 + (0.82 - 0.85) * sky;

      // Ground reflectivity slice, as a plane at y = 0 inside the domain.
      let tGround = Infinity;
      if (dy < -1e-6) {
        const t = -cam[1] / dy;
        const gx = cam[0] + dx * t;
        const gz = cam[2] + dz * t;
        if (t > 0 && Math.abs(gx) <= BX / 2 && Math.abs(gz) <= BZ / 2) {
          tGround = t;
          const i = Math.min(nx - 1, Math.max(0, Math.floor((gx / BX + 0.5) * nx)));
          const j = Math.min(ny - 1, Math.max(0, Math.floor((gz / BZ + 0.5) * ny)));
          const c = cm1Color(groundDbz[i + nx * j]);
          r = c[0] / 255; g = c[1] / 255; b = c[2] / 255;
        }
      }

      // Cloud iso-surface.
      if (bounds) {
        const hit = hitBox(cam[0], cam[1], cam[2], dx, dy, dz,
          bounds[0], bounds[1], bounds[2], bounds[3], bounds[4], bounds[5]);
        if (hit) {
          const [t0, t1] = hit;
          const dt = (t1 - t0) / STEPS;
          for (let s = 0; s < STEPS; s++) {
            const t = t0 + (s + 0.5) * dt;
            if (t > tGround) break;
            const x = cam[0] + dx * t, y = cam[1] + dy * t, z = cam[2] + dz * t;
            if (sampleCloud(x, y, z) < ISO) continue;
            const h = 0.004;
            let gxv = sampleCloud(x + h, y, z) - sampleCloud(x - h, y, z);
            let gyv = sampleCloud(x, y + h, z) - sampleCloud(x, y - h, z);
            let gzv = sampleCloud(x, y, z + h) - sampleCloud(x, y, z - h);
            const gl = Math.hypot(gxv, gyv, gzv);
            let nxv: number, nyv: number, nzv: number;
            if (gl > 1e-5) { nxv = -gxv / gl; nyv = -gyv / gl; nzv = -gzv / gl; }
            else { nxv = -dx; nyv = -dy; nzv = -dz; }
            const diff = Math.max(0, nxv * SUN[0] + nyv * SUN[1] + nzv * SUN[2]);
            const amb = 0.5 + 0.5 * nyv;
            const v = Math.max(0, Math.min(1, 0.05 + 0.27 * amb + 0.72 * diff));
            r = v; g = v; b = v;
            break;
          }
        }
      }

      const o = (py * W + px) * 3;
      rgb[o] = Math.round(255 * Math.max(0, Math.min(1, r)));
      rgb[o + 1] = Math.round(255 * Math.max(0, Math.min(1, g)));
      rgb[o + 2] = Math.round(255 * Math.max(0, Math.min(1, b)));
    }
  }
}

// --- drive -----------------------------------------------------------------
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const dt = cfg.numerics.dt;
const startStep = Math.round((START_MIN * 60) / dt);
const endStep = Math.round((END_MIN * 60) / dt);
const stride = Math.max(1, Math.round((endStep - startStep) / (FRAMES - 1)));

console.log(
  `${nx}x${ny}x${nz}, ${W}x${H}, ${FRAMES} frames from ${START_MIN} to ${END_MIN} min`
);
const t0 = Date.now();
let frame = 0;
for (let step = 1; step <= endStep && frame < FRAMES; step++) {
  solver.step();
  if (step < startStep || (step - startStep) % stride) continue;
  grab();
  renderFrame((-38 * Math.PI) / 180 + (frame / FRAMES) * 0.55);
  writeFileSync(`${OUT}/f${String(frame).padStart(3, "0")}.png`, encodePng(W, H, rgb));
  const d = solver.diagnostics();
  frame++;
  process.stdout.write(
    `\rframe ${String(frame).padStart(3)}/${FRAMES}  t=${(d.time / 60).toFixed(0)}min  ` +
      `w=${d.maxW.toFixed(0)}  top=${(d.cloudTop / 1000).toFixed(1)}km  ` +
      `graupel=${d.maxQg.toFixed(1)}   `
  );
}
console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
