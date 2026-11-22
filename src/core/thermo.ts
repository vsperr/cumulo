import { Rd, cp, g, p00, Lv, eps } from "./constants";

/** Saturation vapour pressure over liquid water [Pa] (Bolton 1980). */
export function esat(T: number): number {
  return 611.2 * Math.exp((17.67 * (T - 273.15)) / (T - 29.65));
}

/** Saturation mixing ratio [kg/kg]. */
export function qsat(T: number, p: number): number {
  const es = Math.min(esat(T), 0.98 * p);
  return (eps * es) / Math.max(p - es, 1.0);
}

/** Exner function from pressure. */
export function exner(p: number): number {
  return Math.pow(p / p00, Rd / cp);
}

/** Pressure from Exner function [Pa]. */
export function pressureFromExner(pi: number): number {
  return p00 * Math.pow(pi, cp / Rd);
}

/** Virtual potential temperature. */
export function thetaV(theta: number, qv: number, qc = 0): number {
  return theta * (1 + 0.6078 * qv - qc);
}

/** Dewpoint [K] from vapour mixing ratio and pressure. */
export function dewpoint(qv: number, p: number): number {
  const e = Math.max((qv * p) / (eps + qv), 1e-3);
  const lne = Math.log(e / 611.2);
  return (29.65 * lne - 17.67 * 273.15) / (lne - 17.67);
}

/** Relative humidity [0..1]. */
export function relHumidity(qv: number, T: number, p: number): number {
  return qv / Math.max(qsat(T, p), 1e-12);
}

/** Mixing ratio that gives the requested relative humidity. */
export function qvFromRH(rh: number, T: number, p: number): number {
  return rh * qsat(T, p);
}

export interface ParcelDiagnostics {
  cape: number; // J/kg
  cin: number; // J/kg
  lclZ: number; // m
  lfcZ: number; // m, NaN when none
  elZ: number; // m, NaN when none
  liftedIndex: number; // K
  pwat: number; // mm
  /** Parcel virtual temperature on the model levels [K], NaN above the top. */
  parcelTv: Float64Array;
}

/**
 * Lift a surface-based parcel through the given profile and return the usual
 * convective indices. Pseudo-adiabatic ascent, liquid-only, no ice.
 */
export function parcelAscent(
  z: Float64Array,
  p: Float64Array,
  theta: Float64Array,
  qv: Float64Array,
  mixDepth = 0
): ParcelDiagnostics {
  const n = z.length;
  const parcelTv = new Float64Array(n).fill(NaN);

  // Parcel source: mean of the lowest `mixDepth` metres (0 = lowest level).
  let th0 = theta[0];
  let qv0 = qv[0];
  if (mixDepth > 0) {
    let wsum = 0;
    let ths = 0;
    let qs = 0;
    for (let k = 0; k < n && z[k] <= mixDepth; k++) {
      const w = k === 0 ? z[1] - z[0] : z[k] - z[k - 1];
      ths += theta[k] * w;
      qs += qv[k] * w;
      wsum += w;
    }
    if (wsum > 0) {
      th0 = ths / wsum;
      qv0 = qs / wsum;
    }
  }

  let cape = 0;
  let cin = 0;
  let lclZ = NaN;
  let lfcZ = NaN;
  let elZ = NaN;
  let liftedIndex = NaN;
  let saturated = false;
  let thParcel = th0;
  let qvParcel = qv0;
  let prevBuoy = 0;
  let prevZ = z[0];

  for (let k = 0; k < n; k++) {
    const pi = exner(p[k]);
    let Tp = thParcel * pi;

    if (!saturated) {
      const qs = qsat(Tp, p[k]);
      if (qvParcel >= qs) {
        saturated = true;
        if (isNaN(lclZ)) lclZ = z[k];
      }
    }
    if (saturated) {
      // Iterative saturation adjustment along the moist adiabat.
      for (let it = 0; it < 12; it++) {
        const qs = qsat(Tp, p[k]);
        const dqs =
          (qsat(Tp + 0.05, p[k]) - qsat(Tp - 0.05, p[k])) / 0.1;
        const f = qvParcel - qs;
        const dcond = f / (1 + (Lv / cp) * dqs);
        if (Math.abs(dcond) < 1e-9) break;
        qvParcel -= dcond;
        Tp += (Lv / cp) * dcond;
      }
      thParcel = Tp / pi;
      qvParcel = qsat(Tp, p[k]);
    }

    const TvParcel = Tp * (1 + 0.6078 * qvParcel);
    const TvEnv = theta[k] * pi * (1 + 0.6078 * qv[k]);
    parcelTv[k] = TvParcel;
    const buoy = (g * (TvParcel - TvEnv)) / TvEnv;

    if (k > 0) {
      const dz = z[k] - prevZ;
      const contrib = 0.5 * (buoy + prevBuoy) * dz;
      if (contrib > 0) {
        if (!isNaN(lclZ) && z[k] >= lclZ) {
          if (isNaN(lfcZ)) lfcZ = prevZ;
          cape += contrib;
        }
      } else if (isNaN(lfcZ)) {
        cin += contrib;
      } else if (cape > 0 && isNaN(elZ)) {
        elZ = prevZ;
      }
    }
    if (isNaN(liftedIndex) && p[k] <= 50000) {
      liftedIndex = TvEnv - TvParcel;
    }
    prevBuoy = buoy;
    prevZ = z[k];
  }

  // Precipitable water.
  let pwat = 0;
  for (let k = 1; k < n; k++) {
    pwat += (0.5 * (qv[k] + qv[k - 1]) * (p[k - 1] - p[k])) / g;
  }

  // CIN is the negative area between the surface and the LFC. With no LFC the
  // parcel never becomes buoyant, so there is no inhibition to quote: the
  // running total would otherwise accumulate all the way to the stratosphere.
  const cinOut = isNaN(lfcZ) ? NaN : -cin;

  return {
    cape,
    cin: cinOut,
    lclZ,
    lfcZ,
    elZ,
    liftedIndex: isNaN(liftedIndex) ? 0 : liftedIndex,
    pwat,
    parcelTv,
  };
}

/** Bulk wind difference between the surface and a given height [m/s]. */
export function bulkShear(
  z: Float64Array,
  u: Float64Array,
  v: Float64Array,
  top: number
): number {
  let kt = z.length - 1;
  for (let k = 0; k < z.length; k++) {
    if (z[k] >= top) {
      kt = k;
      break;
    }
  }
  const du = u[kt] - u[0];
  const dv = v[kt] - v[0];
  return Math.hypot(du, dv);
}

/** Storm-relative helicity over a layer, using a fixed storm motion. */
export function srh(
  z: Float64Array,
  u: Float64Array,
  v: Float64Array,
  top: number,
  cu: number,
  cv2: number
): number {
  let total = 0;
  for (let k = 1; k < z.length && z[k - 1] < top; k++) {
    const u0 = u[k - 1] - cu;
    const v0 = v[k - 1] - cv2;
    const u1 = u[k] - cu;
    const v1 = v[k] - cv2;
    total += u0 * v1 - u1 * v0;
  }
  return -total;
}
