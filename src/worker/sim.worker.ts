/// <reference lib="webworker" />
import { Solver, type Diagnostics } from "../core/solver";
import { parcelAscent, bulkShear, srh, dewpoint } from "../core/thermo";
import { baseStateToLevels, toInputSounding } from "../core/sounding";
import { toHalf } from "../core/half";
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
  | { type: "recycle"; buf: ArrayBuffer };

export type FromWorker =
  | { type: "base"; base: BaseStateMessage }
  | {
      type: "frame";
      buf: ArrayBuffer;
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
 * Pack the frame the renderer needs: cloud [g/kg], rain [g/kg], w [m/s], as
 * half floats so the GPU will filter the volume smoothly.
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
        out[o + 3] = 0;
      }
    }
  }
  return { buf, wMax };
}

function emit(): void {
  if (!solver) return;
  const { buf } = packFrame();
  const diag = solver.diagnostics();
  post({ type: "frame", buf, diag, msPerStep }, [buf]);
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
    }
  } catch (err) {
    post({ type: "error", message: String((err as Error).message ?? err) });
  }
};
