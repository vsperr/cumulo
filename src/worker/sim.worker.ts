/// <reference lib="webworker" />
import { Solver, type Diagnostics } from "../core/solver";
import { parcelAscent, bulkShear, srh, dewpoint } from "../core/thermo";
import { baseStateToLevels, toInputSounding } from "../core/sounding";
import { toHalf } from "../core/half";
import { reflectivityDbz } from "../core/radar";
import type { Config, SoundingLevel } from "../core/config";

/** Base-state summary shipped to the UI for the sounding diagram. */
export interface BaseStateMessage {
  z: number[];
  p: number[];
  T: number[];
  Td: number[];
  theta: number[];
  qv: number[];
  u: number[];
  v: number[];
  parcelT: number[];
  cape: number;
  cin: number;
  lclZ: number;
  lfcZ: number;
  elZ: number;
  pwat: number;
  liftedIndex: number;
  shear6: number;
  shear1: number;
  srh3: number;
  soundSpeed: number;
  maxAcousticDt: number;
  levels: SoundingLevel[];
  inputSounding: string;
}

export type ToWorker =
  | { type: "init"; cfg: Config }
  | { type: "config"; cfg: Config; rebuild: boolean }
  | { type: "run"; running: boolean }
  | { type: "reset" }
  | { type: "steps"; n: number }
  | { type: "recycle"; buf: ArrayBuffer }
  | { type: "recycleRadar"; buf: ArrayBuffer };

/** Radar products, computed from the rain field at full precision. */
export interface RadarFrame {
  /** Float32: composite dBZ (nx*ny), echo top in m (nx*ny), section (nx*nz). */
  buf: ArrayBuffer;
  nx: number;
  ny: number;
  nz: number;
  /** Row the vertical section was cut through: the one holding the strongest echo. */
  sectionJ: number;
  maxDbz: number;
  /** Height of the highest 18 dBZ echo anywhere in the domain [m]. */
  echoTopMax: number;
}

export type FromWorker =
  | { type: "base"; base: BaseStateMessage }
  | {
      type: "frame";
      buf: ArrayBuffer;
      radar: RadarFrame;
      diag: Diagnostics;
      msPerStep: number;
    }
  | { type: "error"; message: string };

let solver: Solver | null = null;
let running = false;
let pending = 0;
let msPerStep = 0;
const spare: ArrayBuffer[] = [];
let scheduled = false;

function post(m: FromWorker, transfer?: Transferable[]): void {
  (self as unknown as Worker).postMessage(m, transfer ?? []);
}

function describeBase(): void {
  if (!solver) return;
  const b = solver.base;
  const diag = parcelAscent(b.z, b.p, b.theta, b.qv);
  const Td = new Float64Array(b.nz);
  for (let k = 0; k < b.nz; k++) Td[k] = dewpoint(b.qv[k], b.p[k]);
  // Storm motion for helicity: 75% of the 0-6 km mean wind, 30 deg to the right.
  let um = 0;
  let vm = 0;
  let n = 0;
  for (let k = 0; k < b.nz && b.z[k] <= 6000; k++) {
    um += b.u[k];
    vm += b.v[k];
    n++;
  }
  if (n > 0) {
    um /= n;
    vm /= n;
  }
  const msg: BaseStateMessage = {
    z: Array.from(b.z),
    p: Array.from(b.p),
    T: Array.from(b.T),
    Td: Array.from(Td),
    theta: Array.from(b.theta),
    qv: Array.from(b.qv),
    u: Array.from(b.u),
    v: Array.from(b.v),
    parcelT: Array.from(diag.parcelTv),
    cape: diag.cape,
    cin: diag.cin,
    lclZ: diag.lclZ,
    lfcZ: diag.lfcZ,
    elZ: diag.elZ,
    pwat: diag.pwat,
    liftedIndex: diag.liftedIndex,
    shear6: bulkShear(b.z, b.u, b.v, 6000),
    shear1: bulkShear(b.z, b.u, b.v, 1000),
    srh3: srh(b.z, b.u, b.v, 3000, um * 0.75, vm * 0.75),
    soundSpeed: solver.soundSpeed(),
    maxAcousticDt: solver.maxAcousticDt(),
    levels: baseStateToLevels(b, 1),
    inputSounding: toInputSounding(solver.cfg, b),
  };
  post({ type: "base", base: msg });
}

/**
 * Pack the frame the renderer needs: cloud [g/kg], rain [g/kg], w [m/s] and
 * radar reflectivity [dBZ], as half floats. Reflectivity is computed here
 * rather than in the shader because it needs the air density profile.
 */
function packFrame(): { buf: ArrayBuffer; wMax: number } {
  const s = solver!;
  const { nx, ny, nz } = s;
  const n = nx * ny * nz;
  let buf = spare.pop();
  if (!buf || buf.byteLength !== n * 4 * 2) buf = new ArrayBuffer(n * 4 * 2);
  const out = new Uint16Array(buf);
  let wMax = 1;
  for (let k = 0; k < nz; k++) {
    const rho = s.base.rho[k];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const m = i + nx * (j + ny * k);
        const w =
          0.5 *
          (s.w[i + nx * (j + ny * k)] + s.w[i + nx * (j + ny * (k + 1))]);
        const aw = Math.abs(w);
        if (aw > wMax) wMax = aw;
        const o = m * 4;
        out[o] = toHalf(s.qc[m] * 1e3);
        out[o + 1] = toHalf(s.qr[m] * 1e3);
        out[o + 2] = toHalf(w);
        out[o + 3] = toHalf(reflectivityDbz(rho, s.qr[m]));
      }
    }
  }
  return { buf, wMax };
}

const radarSpare: ArrayBuffer[] = [];

/**
 * Build the radar products: column-maximum reflectivity (what a radar's
 * composite product shows), echo top (the highest 18 dBZ return, the standard
 * threshold), and a vertical section cut through the strongest echo.
 */
function packRadar(): RadarFrame {
  const s = solver!;
  const { nx, ny, nz } = s;
  const nxy = nx * ny;
  const need = (2 * nxy + nx * nz) * 4;
  let buf = radarSpare.pop();
  if (!buf || buf.byteLength !== need) buf = new ArrayBuffer(need);
  const out = new Float32Array(buf);
  out.fill(0);

  const comp = out.subarray(0, nxy);
  const tops = out.subarray(nxy, 2 * nxy);
  const sect = out.subarray(2 * nxy);

  let maxDbz = -99;
  let maxAt = 0;
  let echoTopMax = 0;

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = i + nx * j;
      let best = -99;
      let top = 0;
      for (let k = 0; k < nz; k++) {
        const dbz = reflectivityDbz(s.base.rho[k], s.qr[i + nx * (j + ny * k)]);
        if (dbz > best) best = dbz;
        if (dbz >= 18) top = s.base.zw[k + 1];
      }
      comp[c] = best;
      tops[c] = top;
      if (top > echoTopMax) echoTopMax = top;
      if (best > maxDbz) {
        maxDbz = best;
        maxAt = c;
      }
    }
  }

  // Cut the section through the row with the strongest echo, so it follows
  // the storm instead of sitting on an arbitrary line.
  const sectionJ = Math.floor(maxAt / nx);
  for (let k = 0; k < nz; k++)
    for (let i = 0; i < nx; i++)
      sect[i + nx * k] = reflectivityDbz(
        s.base.rho[k],
        s.qr[i + nx * (sectionJ + ny * k)]
      );

  return { buf, nx, ny, nz, sectionJ, maxDbz, echoTopMax };
}

function emit(): void {
  if (!solver) return;
  const { buf } = packFrame();
  const radar = packRadar();
  const diag = solver.diagnostics();
  post({ type: "frame", buf, radar, diag, msPerStep }, [buf, radar.buf]);
}

function tick(): void {
  scheduled = false;
  if (!solver) return;
  const n = running ? Math.max(1, solver.cfg.numerics.stepsPerFrame) : pending;
  pending = 0;
  if (n > 0) {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) solver.step();
    msPerStep = (performance.now() - t0) / n;
  }
  emit();
  if (running && solver.stable) schedule();
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  setTimeout(tick, 0);
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  try {
    switch (m.type) {
      case "init":
        solver = new Solver(m.cfg);
        describeBase();
        emit();
        break;
      case "config": {
        if (!solver) return;
        if (m.rebuild) {
          solver.reconfigure(m.cfg);
          describeBase();
          emit();
        } else {
          solver.cfg = m.cfg;
        }
        break;
      }
      case "run":
        running = m.running;
        if (running) schedule();
        break;
      case "reset":
        if (!solver) return;
        solver.initialise();
        emit();
        break;
      case "steps":
        pending += m.n;
        schedule();
        break;
      case "recycle":
        if (spare.length < 3) spare.push(m.buf);
        break;
      case "recycleRadar":
        if (radarSpare.length < 3) radarSpare.push(m.buf);
        break;
    }
  } catch (err) {
    post({ type: "error", message: String((err as Error).message ?? err) });
  }
};
