import { Rd, cp, g } from "./constants";
import { exner, pressureFromExner, qsat, thetaV } from "./thermo";
import type { Config, SoundingLevel, SoundingConfig } from "./config";

/**
 * The hydrostatically balanced base state the model is initialised from and
 * linearised about. Arrays are indexed by model level (cell centres), with the
 * `*W` variants on the vertical faces (w levels).
 */
export interface BaseState {
  nz: number;
  dz: number;
  z: Float64Array; // cell centres [m]
  zw: Float64Array; // faces, length nz+1 [m]
  theta: Float64Array; // K
  thetaV: Float64Array; // K
  qv: Float64Array; // kg/kg
  u: Float64Array; // m/s
  v: Float64Array; // m/s
  pi: Float64Array; // Exner
  p: Float64Array; // Pa
  T: Float64Array; // K
  rho: Float64Array; // kg/m^3
  piW: Float64Array; // Exner on faces, length nz+1
  rhoW: Float64Array; // length nz+1
  thetaVW: Float64Array; // length nz+1
}

function clamp(x: number, a: number, b: number): number {
  return x < a ? a : x > b ? b : x;
}

/** Analytic Weisman & Klemp (1982) potential temperature profile. */
function analyticTheta(s: SoundingConfig, z: number): number {
  const zt = s.zTropopause;
  if (z <= s.mixedLayerDepth) return s.thetaSfc;
  if (z <= zt) {
    const f = Math.pow(
      clamp((z - s.mixedLayerDepth) / Math.max(zt - s.mixedLayerDepth, 1), 0, 1),
      s.thetaExponent
    );
    return s.thetaSfc + (s.thetaTropopause - s.thetaSfc) * f;
  }
  // Isothermal stratosphere at tempTropopause.
  return (
    s.thetaTropopause *
    Math.exp((g / (cp * s.tempTropopause)) * (z - zt))
  );
}

/** Analytic relative humidity profile. */
function analyticRH(s: SoundingConfig, z: number): number {
  const zt = s.zTropopause;
  if (z >= zt) return s.rhTropopause;
  const f = Math.pow(clamp(z / zt, 0, 1), s.rhExponent);
  return s.rhSfc + (s.rhTropopause - s.rhSfc) * f;
}

function interpLevels(levels: SoundingLevel[], z: number): SoundingLevel {
  const n = levels.length;
  if (n === 0) return { z, theta: 300, qv: 0, u: 0, v: 0 };
  if (z <= levels[0].z) return levels[0];
  if (z >= levels[n - 1].z) return levels[n - 1];
  for (let k = 1; k < n; k++) {
    if (z <= levels[k].z) {
      const a = levels[k - 1];
      const b = levels[k];
      const t = (z - a.z) / Math.max(b.z - a.z, 1e-6);
      return {
        z,
        theta: a.theta + t * (b.theta - a.theta),
        qv: a.qv + t * (b.qv - a.qv),
        u: a.u + t * (b.u - a.u),
        v: a.v + t * (b.v - a.v),
      };
    }
  }
  return levels[n - 1];
}

/** Wind components of the configured hodograph at height z. */
export function windAt(s: SoundingConfig, z: number): [number, number] {
  let u = 0;
  let v = 0;
  const f = clamp(z / Math.max(s.shearDepth, 1), 0, 1);
  switch (s.windMode) {
    case "none":
      u = s.uSfc;
      v = s.vSfc;
      break;
    case "linear":
      u = s.uSfc + s.shearMag * f;
      v = s.vSfc;
      break;
    case "quarterCircle": {
      const R = s.shearMag;
      const a = (-Math.PI / 2) * (1 - f);
      u = s.uSfc + R * (Math.cos(a) - Math.cos(-Math.PI / 2));
      v = s.vSfc + R * (Math.sin(a) - Math.sin(-Math.PI / 2));
      break;
    }
    case "halfCircle": {
      const R = s.shearMag / 2;
      const a = -Math.PI / 2 + Math.PI * f;
      u = s.uSfc + R * Math.cos(a);
      v = s.vSfc + R * (Math.sin(a) + 1);
      break;
    }
    case "table":
      return [0, 0];
  }
  return [u - s.galileanU, v - s.galileanV];
}

/**
 * Build the base state: fills theta/qv/wind from the configured sounding, then
 * integrates the hydrostatic equation for the Exner pressure. Because the
 * moisture depends on pressure and the pressure depends on the virtual
 * temperature, the column is iterated to convergence.
 */
export function buildBaseState(cfg: Config): BaseState {
  const { nz, dz } = cfg.grid;
  const s = cfg.sounding;
  const z = new Float64Array(nz);
  const zw = new Float64Array(nz + 1);
  for (let k = 0; k < nz; k++) z[k] = (k + 0.5) * dz;
  for (let k = 0; k <= nz; k++) zw[k] = k * dz;

  const theta = new Float64Array(nz);
  const qv = new Float64Array(nz);
  const u = new Float64Array(nz);
  const v = new Float64Array(nz);
  const rh = new Float64Array(nz);

  for (let k = 0; k < nz; k++) {
    if (s.mode === "analytic") {
      theta[k] = analyticTheta(s, z[k]);
      rh[k] = analyticRH(s, z[k]);
    } else {
      const lv = interpLevels(s.levels, z[k]);
      theta[k] = lv.theta;
      qv[k] = lv.qv * 1e-3;
    }
    if (s.mode === "table" && s.windMode === "table") {
      const lv = interpLevels(s.levels, z[k]);
      u[k] = lv.u - s.galileanU;
      v[k] = lv.v - s.galileanV;
    } else {
      const [uu, vv] = windAt(s, z[k]);
      u[k] = uu;
      v[k] = vv;
    }
  }

  const pi = new Float64Array(nz);
  const p = new Float64Array(nz);
  const T = new Float64Array(nz);
  const rho = new Float64Array(nz);
  const thv = new Float64Array(nz);
  const piSfc = exner(s.psfc * 100);

  for (let iter = 0; iter < 30; iter++) {
    for (let k = 0; k < nz; k++) thv[k] = thetaV(theta[k], qv[k]);
    // Integrate dpi/dz = -g / (cp * thetaV) upward from the surface.
    pi[0] = piSfc - (g * (0.5 * dz)) / (cp * thv[0]);
    for (let k = 1; k < nz; k++) {
      const thvMid = 0.5 * (thv[k] + thv[k - 1]);
      pi[k] = pi[k - 1] - (g * dz) / (cp * thvMid);
    }
    let maxChange = 0;
    for (let k = 0; k < nz; k++) {
      p[k] = pressureFromExner(pi[k]);
      T[k] = theta[k] * pi[k];
      if (s.mode === "analytic") {
        const target = Math.min(rh[k] * qsat(T[k], p[k]), s.qvMax * 1e-3);
        maxChange = Math.max(maxChange, Math.abs(target - qv[k]));
        qv[k] = target;
      }
    }
    if (maxChange < 1e-10) break;
  }

  for (let k = 0; k < nz; k++) {
    thv[k] = thetaV(theta[k], qv[k]);
    rho[k] = p[k] / (Rd * T[k] * (1 + 0.6078 * qv[k]));
  }

  const piW = new Float64Array(nz + 1);
  const rhoW = new Float64Array(nz + 1);
  const thvW = new Float64Array(nz + 1);
  piW[0] = piSfc;
  thvW[0] = thv[0];
  for (let k = 1; k < nz; k++) {
    piW[k] = 0.5 * (pi[k] + pi[k - 1]);
    thvW[k] = 0.5 * (thv[k] + thv[k - 1]);
  }
  piW[nz] = pi[nz - 1] - (g * (0.5 * dz)) / (cp * thv[nz - 1]);
  thvW[nz] = thv[nz - 1];
  for (let k = 0; k <= nz; k++) {
    const pw = pressureFromExner(piW[k]);
    rhoW[k] = pw / (Rd * Math.max(thvW[k] * piW[k], 1));
  }

  return {
    nz,
    dz,
    z,
    zw,
    theta,
    thetaV: thv,
    qv,
    u,
    v,
    pi,
    p,
    T,
    rho,
    piW,
    rhoW,
    thetaVW: thvW,
  };
}

/** Sample the current base state as an editable level table. */
export function baseStateToLevels(b: BaseState, step = 2): SoundingLevel[] {
  const out: SoundingLevel[] = [];
  for (let k = 0; k < b.nz; k += step) {
    out.push({
      z: Math.round(b.z[k]),
      theta: Math.round(b.theta[k] * 100) / 100,
      qv: Math.round(b.qv[k] * 1e5) / 100,
      u: Math.round(b.u[k] * 100) / 100,
      v: Math.round(b.v[k] * 100) / 100,
    });
  }
  return out;
}

/** Serialise to the CM1 / WRF `input_sounding` format. */
export function toInputSounding(cfg: Config, b: BaseState): string {
  const s = cfg.sounding;
  const lines: string[] = [];
  lines.push(
    `${s.psfc.toFixed(2)} ${b.theta[0].toFixed(2)} ${(b.qv[0] * 1e3).toFixed(4)}`
  );
  for (let k = 0; k < b.nz; k++) {
    lines.push(
      [
        b.z[k].toFixed(1),
        b.theta[k].toFixed(3),
        (b.qv[k] * 1e3).toFixed(4),
        b.u[k].toFixed(3),
        b.v[k].toFixed(3),
      ].join(" ")
    );
  }
  return lines.join("\n") + "\n";
}

/** Parse the CM1 / WRF `input_sounding` format. */
export function parseInputSounding(text: string): {
  psfc: number;
  thetaSfc: number;
  qvSfc: number;
  levels: SoundingLevel[];
} {
  const rows = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map((l) => l.split(/[\s,]+/).map(Number));
  if (rows.length === 0) throw new Error("empty sounding");
  const head = rows[0];
  if (head.length < 3) throw new Error("first line must be: psfc theta qv");
  const levels: SoundingLevel[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < 3 || r.some((x) => !isFinite(x))) continue;
    levels.push({
      z: r[0],
      theta: r[1],
      qv: r[2],
      u: r[3] ?? 0,
      v: r[4] ?? 0,
    });
  }
  if (levels.length < 2) throw new Error("need at least two levels");
  levels.sort((a, b2) => a.z - b2.z);
  return { psfc: head[0], thetaSfc: head[1], qvSfc: head[2], levels };
}
