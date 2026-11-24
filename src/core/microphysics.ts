import { cp, Lv, Lf, Ls, Rv, T0, eps } from "./constants";
import { qsat, pressureFromExner } from "./thermo";
import type { BaseState } from "./sounding";
import type { PhysicsConfig } from "./config";

export interface MicroFields {
  nx: number;
  ny: number;
  nz: number;
  thp: Float32Array; // theta perturbation [K]
  qvp: Float32Array; // vapour perturbation from base [kg/kg]
  qc: Float32Array; // cloud water [kg/kg]
  qr: Float32Array; // rain [kg/kg]
  qi: Float32Array; // cloud ice [kg/kg]
  qs: Float32Array; // snow [kg/kg]
  qg: Float32Array; // graupel [kg/kg]
  pip: Float32Array; // Exner perturbation
  rainAccum: Float32Array; // liquid at the surface [mm], size nx*ny
  snowAccum: Float32Array; // frozen at the surface [mm water equivalent]
}

/** Saturation vapour pressure over ice [Pa] (Alduchov & Eskridge 1996). */
export function esatIce(T: number): number {
  const tc = T - T0;
  return 611.21 * Math.exp((22.587 * tc) / (273.86 + tc));
}

/** Saturation mixing ratio over ice [kg/kg]. */
export function qsatIce(T: number, p: number): number {
  const e = Math.min(esatIce(T), 0.98 * p);
  return (eps * e) / Math.max(p - e, 1.0);
}

/**
 * Mass-weighted terminal fall speeds [m/s], for exponential size
 * distributions. They put cloud ice below 1 m/s, snow near 1 m/s and graupel
 * at several, which is what separates a slowly spreading anvil from a hail
 * shaft.
 *
 * Note the units: Kessler's rain relation takes the rain water content in
 * g/cm^3, so the kg/m^3 the model works in has to be scaled by 1e-3 first.
 * Without that the drops fall two and a half times too fast, reach the ground
 * before they can evaporate, and the storm never builds a cold pool. The ice
 * coefficients below are written for kg/m^3 directly.
 */
export function fallSpeedRain(rho: number, q: number, rho0: number): number {
  return 36.34 * Math.pow(1e-3 * rho * q, 0.1364) * Math.sqrt(rho0 / rho);
}
export function fallSpeedIce(rho: number, q: number, rho0: number): number {
  return 3.29 * Math.pow(rho * q, 0.16) * Math.sqrt(rho0 / rho);
}
export function fallSpeedSnow(rho: number, q: number, rho0: number): number {
  return 4.84 * Math.pow(rho * q, 0.25) * Math.sqrt(rho0 / rho);
}
export function fallSpeedGraupel(rho: number, q: number, rho0: number): number {
  return 19.3 * Math.pow(rho * q, 0.125) * Math.sqrt(rho0 / rho);
}

/**
 * Ventilation factor of the Ogura & Takahashi (1971) evaporation rate, the
 * one Kessler schemes use. A falling drop sweeps out air, so it evaporates far
 * faster than a still one: this term is worth a factor of thirty to forty, and
 * without it a storm makes no cold pool worth the name.
 */
function ventilation(rhoQ: number): number {
  return 1.6 + 124.9 * Math.pow(rhoQ, 0.2046);
}

export interface MicroResult {
  surfaceRainRate: number; // mm/h, domain mean, liquid
  surfaceSnowRate: number; // mm/h water equivalent, frozen
}

/**
 * Warm rain after Kessler (1969), with an optional single-moment ice phase.
 *
 * The ice part carries three extra species — cloud ice, snow and graupel —
 * and the conversions between them are the standard set of a Lin-type scheme,
 * written in the simplest form that keeps the energy book straight:
 *
 *   vapour  <-> cloud ice            deposition / sublimation      (Ls)
 *   cloud water -> cloud ice         freezing, homogeneous below -40 C (Lf)
 *   rain    -> graupel               freezing                      (Lf)
 *   cloud ice -> snow                autoconversion                 —
 *   snow, graupel + cloud water      riming                        (Lf)
 *   snow, graupel + rain             collection                    (Lf)
 *   snow, graupel -> rain            melting above 0 C             (Lf)
 *
 * Every rate is a relaxation with an explicit timescale rather than a fitted
 * collection integral: it is a teaching model, and a rate you can read beats
 * a coefficient you cannot. All of them are exposed in PhysicsConfig.
 *
 * What the ice phase buys, and why it is worth the extra fields: latent heat
 * of fusion in the updraft (a taller, colder storm), anvils made of ice that
 * spread and persist instead of evaporating, melting below the freezing level
 * (a markedly colder, stronger cold pool) and graupel, which is what produces
 * the high reflectivity cores a radar actually sees in a severe storm.
 */
export function applyMicrophysics(
  f: MicroFields,
  base: BaseState,
  phys: PhysicsConfig,
  dt: number
): MicroResult {
  const { nx, ny, nz } = f;
  const nxy = nx * ny;
  const rho0 = base.rho[0];
  const ice = phys.ice;

  for (let k = 0; k < nz; k++) {
    const thb = base.theta[k];
    const pib = base.pi[k];
    const qvb = base.qv[k];
    const rho = base.rho[k];

    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const n = i + nx * (j + ny * k);
        const pi = pib + f.pip[n];
        const p = pressureFromExner(pi);
        let qv = qvb + f.qvp[n];
        let qc = f.qc[n];
        let qr = f.qr[n];
        let qi = ice ? f.qi[n] : 0;
        let qs = ice ? f.qs[n] : 0;
        let qg = ice ? f.qg[n] : 0;
        let T = (thb + f.thp[n]) * pi;

        const nothing =
          qc <= 0 && qr <= 0 && qi <= 0 && qs <= 0 && qg <= 0;

        // --- condensation / evaporation of cloud water -------------------
        for (let it = 0; it < 6; it++) {
          const qsw = qsat(T, p);
          const dqs = (qsat(T + 0.05, p) - qsat(T - 0.05, p)) / 0.1;
          let dq = (qv - qsw) / (1 + (Lv / cp) * dqs);
          if (dq < 0) dq = Math.max(dq, -qc);
          if (Math.abs(dq) < 1e-12) break;
          qv -= dq;
          qc += dq;
          T += (Lv / cp) * dq;
        }
        qc = Math.max(qc, 0);

        if (!phys.microphysics) {
          f.qc[n] = qc;
          f.qvp[n] = qv - qvb;
          f.thp[n] = T / pi - thb;
          continue;
        }

        // --- ice phase ----------------------------------------------------
        if (ice && !(nothing && T >= T0)) {
          const tc = T - T0;

          // Deposition onto cloud ice, or sublimation away from it.
          if (tc < 0) {
            const qsi = qsatIce(T, p);
            const seeded = qi > 1e-12 || qc > 1e-9 || tc < -8;
            if (seeded) {
              const denom = 1 + (Ls * Ls * qsi) / (cp * Rv * T * T);
              let dep = ((qv - qsi) / denom) * (1 - Math.exp(-dt / 20));
              if (dep < 0) dep = Math.max(dep, -qi);
              else dep = Math.min(dep, Math.max(qv - qsi, 0));
              if (Math.abs(dep) > 1e-14) {
                qv -= dep;
                qi += dep;
                T += (Ls / cp) * dep;
              }
            }
          }

          // Freezing of cloud water: complete below -40 C, a temperature-ramped
          // relaxation above it.
          if (tc < -40 && qc > 0) {
            qi += qc;
            T += (Lf / cp) * qc;
            qc = 0;
          } else if (tc < 0 && qc > 0) {
            const rate = Math.min(-tc / 40, 1);
            const dq = qc * (1 - Math.exp((-dt * rate) / phys.freezeTime));
            qc -= dq;
            qi += dq;
            T += (Lf / cp) * dq;
          }

          // Freezing rain becomes graupel: bigger drops, denser particles.
          if (tc < 0 && qr > 0) {
            const rate = Math.min(-tc / 40, 1);
            const dq =
              tc < -40
                ? qr
                : qr * (1 - Math.exp((-dt * rate) / (phys.freezeTime * 0.5)));
            qr -= dq;
            qg += dq;
            T += (Lf / cp) * dq;
          }

          // Cloud ice grows into snow.
          if (qi > phys.iceToSnowThreshold) {
            const dq =
              (qi - phys.iceToSnowThreshold) *
              (1 - Math.exp(-dt / phys.iceToSnowTime));
            qi -= dq;
            qs += dq;
          }

          // Riming: snow and graupel sweep up cloud droplets, which freeze.
          if (qc > 0 && qs > 0) {
            const rate = phys.rimingRate * Math.pow(qs, 0.8) * qc;
            const dq = Math.min(qc, rate * dt);
            qc -= dq;
            T += (Lf / cp) * dq;
            // Heavy riming turns snow into graupel; light riming just thickens it.
            const toGraupel = qs > 5e-4 ? dq * 0.5 : 0;
            qs += dq - toGraupel;
            qg += toGraupel;
          }
          if (qc > 0 && qg > 0) {
            const rate = phys.rimingRate * Math.pow(qg, 0.875) * qc;
            const dq = Math.min(qc, rate * dt);
            qc -= dq;
            qg += dq;
            T += (Lf / cp) * dq;
          }
          // Collection of rain by frozen particles.
          if (qr > 0 && qg > 0) {
            const rate = phys.rimingRate * Math.pow(qg, 0.875) * qr;
            const dq = Math.min(qr, rate * dt);
            qr -= dq;
            qg += dq;
            T += (Lf / cp) * dq;
          }
          if (qr > 0 && qs > 0 && tc < 0) {
            const rate = phys.rimingRate * Math.pow(qs, 0.875) * qr;
            const dq = Math.min(qr, rate * dt);
            qr -= dq;
            qg += dq;
            T += (Lf / cp) * dq;
          }

          // Melting above freezing, limited by the heat actually available.
          if (tc > 0) {
            const budget = (cp * tc) / Lf;
            if (qi > 0) {
              const dq = Math.min(qi, budget);
              qi -= dq;
              qr += dq;
              T -= (Lf / cp) * dq;
            }
            const tc2 = T - T0;
            if (tc2 > 0 && qs > 0) {
              const ramp = Math.min(tc2 / 2, 1);
              const dq = Math.min(
                qs * (1 - Math.exp(-dt / phys.meltTime)) * ramp,
                (cp * tc2) / Lf
              );
              qs -= dq;
              qr += dq;
              T -= (Lf / cp) * dq;
            }
            const tc3 = T - T0;
            if (tc3 > 0 && qg > 0) {
              const ramp = Math.min(tc3 / 2, 1);
              const dq = Math.min(
                qg * (1 - Math.exp(-dt / (phys.meltTime * 1.7))) * ramp,
                (cp * tc3) / Lf
              );
              qg -= dq;
              qr += dq;
              T -= (Lf / cp) * dq;
            }
          }

          // Sublimation of snow and graupel falling through dry air.
          if (T < T0 && (qs > 0 || qg > 0)) {
            const qsi = qsatIce(T, p);
            if (qv < qsi) {
              const deficit = qsi - qv;
              for (const which of [0, 1]) {
                const q = which === 0 ? qs : qg;
                if (q <= 0) continue;
                const rq = Math.max(rho * q, 0);
                const c = ventilation(rq) * Math.pow(rq, 0.525);
                const denom = 5.4e5 + 2.55e6 / Math.max(p * qsi, 1);
                const rate =
                  (phys.rainEvaporation * ((deficit / qsi) * c)) / (rho * denom);
                const dq = Math.min(Math.max(rate * dt, 0), Math.min(q, deficit));
                if (dq <= 0) continue;
                if (which === 0) qs -= dq;
                else qg -= dq;
                qv += dq;
                T -= (Ls / cp) * dq;
              }
            }
          }
        }

        // --- warm rain ----------------------------------------------------
        if (qc > phys.autoconversionThreshold) {
          const rate =
            phys.autoconversionRate * (qc - phys.autoconversionThreshold);
          const dq = Math.min(rate * dt, qc);
          qc -= dq;
          qr += dq;
        }
        if (qc > 0 && qr > 0) {
          const rate = phys.accretionRate * qc * Math.pow(qr, 0.875);
          const dq = Math.min(rate * dt, qc);
          qc -= dq;
          qr += dq;
        }
        if (qr > 0) {
          const qsw = qsat(T, p);
          if (qv < qsw) {
            const rq = Math.max(rho * qr, 0);
            const c = ventilation(rq) * Math.pow(rq, 0.525);
            const denom = 5.4e5 + 2.55e6 / Math.max(p * qsw, 1);
            const erate =
              (phys.rainEvaporation * ((1 - qv / qsw) * c)) / (rho * denom);
            const dq = Math.min(
              Math.max(erate * dt, 0),
              Math.min(qr, Math.max(qsw - qv, 0))
            );
            qr -= dq;
            qv += dq;
            T -= (Lv / cp) * dq;
          }
        }

        f.qc[n] = Math.max(qc, 0);
        f.qr[n] = Math.max(qr, 0);
        if (ice) {
          f.qi[n] = Math.max(qi, 0);
          f.qs[n] = Math.max(qs, 0);
          f.qg[n] = Math.max(qg, 0);
        }
        f.qvp[n] = qv - qvb;
        f.thp[n] = T / pi - thb;
      }
    }
  }

  // --- sedimentation --------------------------------------------------
  const dz = base.dz;
  let liquidMass = 0;
  let frozenMass = 0;

  const settle = (
    field: Float32Array,
    speed: (rho: number, q: number, rho0: number) => number,
    scale: number,
    accum: Float32Array | null
  ): number => {
    const vt = new Float64Array(nz);
    const flux = new Float64Array(nz + 1);
    let surface = 0;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let any = false;
        let vmax = 0;
        for (let k = 0; k < nz; k++) {
          const q = field[i + nx * (j + ny * k)];
          if (q > 1e-9) {
            any = true;
            vt[k] = scale * speed(base.rho[k], q, rho0);
            if (vt[k] > vmax) vmax = vt[k];
          } else vt[k] = 0;
        }
        if (!any) continue;

        const nsub = Math.max(1, Math.ceil((vmax * dt) / (0.8 * dz)));
        const dts = dt / nsub;
        for (let sstep = 0; sstep < nsub; sstep++) {
          for (let k = 0; k < nz; k++)
            flux[k] = base.rho[k] * field[i + nx * (j + ny * k)] * vt[k];
          flux[nz] = 0;
          for (let k = 0; k < nz; k++) {
            const m = i + nx * (j + ny * k);
            field[m] = Math.max(
              field[m] + (dts * (flux[k + 1] - flux[k])) / (base.rho[k] * dz),
              0
            );
          }
          const landed = flux[0] * dts;
          if (accum) accum[i + nx * j] += landed;
          surface += landed;
          for (let k = 0; k < nz; k++) {
            const q = field[i + nx * (j + ny * k)];
            vt[k] = q > 1e-9 ? scale * speed(base.rho[k], q, rho0) : 0;
          }
        }
      }
    }
    return surface;
  };

  liquidMass += settle(f.qr, fallSpeedRain, phys.rainFallSpeed, f.rainAccum);
  if (ice) {
    frozenMass += settle(f.qi, fallSpeedIce, phys.iceFallSpeed, f.snowAccum);
    frozenMass += settle(f.qs, fallSpeedSnow, phys.snowFallSpeed, f.snowAccum);
    frozenMass += settle(
      f.qg,
      fallSpeedGraupel,
      phys.graupelFallSpeed,
      f.snowAccum
    );
  }

  return {
    surfaceRainRate: (liquidMass / nxy / dt) * 3600,
    surfaceSnowRate: (frozenMass / nxy / dt) * 3600,
  };
}
