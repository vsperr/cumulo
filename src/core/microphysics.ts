import { cp, Lv } from "./constants";
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
  qr: Float32Array; // rain water [kg/kg]
  pip: Float32Array; // Exner perturbation
  rainAccum: Float32Array; // surface accumulation [mm], size nx*ny
}

/**
 * Kessler (1969) warm-rain microphysics: saturation adjustment, autoconversion
 * of cloud to rain, accretion, evaporation of rain in subsaturated air and
 * sedimentation of rain with a density-dependent terminal fall speed.
 *
 * Every rate is exposed through PhysicsConfig so the scheme can be tuned or
 * switched off entirely.
 */
export function applyMicrophysics(
  f: MicroFields,
  base: BaseState,
  phys: PhysicsConfig,
  dt: number
): { surfaceRainRate: number } {
  const { nx, ny, nz } = f;
  const nxy = nx * ny;
  const rho0 = base.rho[0];

  // --- condensation / evaporation of cloud water (saturation adjustment) ---
  for (let k = 0; k < nz; k++) {
    const thb = base.theta[k];
    const pib = base.pi[k];
    const qvb = base.qv[k];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const n = i + nx * (j + ny * k);
        const pi = pib + f.pip[n];
        const p = pressureFromExner(pi);
        let th = thb + f.thp[n];
        let qv = qvb + f.qvp[n];
        let qc = f.qc[n];
        let T = th * pi;

        for (let it = 0; it < 6; it++) {
          const qs = qsat(T, p);
          const dqs = (qsat(T + 0.05, p) - qsat(T - 0.05, p)) / 0.1;
          let dq = (qv - qs) / (1 + (Lv / cp) * dqs);
          if (dq < 0) dq = Math.max(dq, -qc); // cannot evaporate more than exists
          if (Math.abs(dq) < 1e-12) break;
          qv -= dq;
          qc += dq;
          T += ((Lv / cp) * dq) / 1;
        }
        th = T / pi;
        f.thp[n] = th - thb;
        f.qvp[n] = qv - qvb;
        f.qc[n] = Math.max(qc, 0);
      }
    }
  }

  if (!phys.microphysics) return { surfaceRainRate: 0 };

  // --- autoconversion, accretion, rain evaporation ---
  for (let k = 0; k < nz; k++) {
    const thb = base.theta[k];
    const pib = base.pi[k];
    const qvb = base.qv[k];
    const rho = base.rho[k];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const n = i + nx * (j + ny * k);
        let qc = f.qc[n];
        let qr = f.qr[n];
        if (qc <= 0 && qr <= 0) continue;

        // Autoconversion: cloud water above a threshold becomes rain.
        if (qc > phys.autoconversionThreshold) {
          const rate =
            phys.autoconversionRate * (qc - phys.autoconversionThreshold);
          const dq = Math.min(rate * dt, qc);
          qc -= dq;
          qr += dq;
        }
        // Accretion: falling rain collects cloud droplets.
        if (qc > 0 && qr > 0) {
          const rate = phys.accretionRate * qc * Math.pow(qr, 0.875);
          const dq = Math.min(rate * dt, qc);
          qc -= dq;
          qr += dq;
        }
        // Evaporation of rain into subsaturated air.
        if (qr > 0) {
          const pi = pib + f.pip[n];
          const p = pressureFromExner(pi);
          const th = thb + f.thp[n];
          const T = th * pi;
          const qv = qvb + f.qvp[n];
          const qs = qsat(T, p);
          if (qv < qs) {
            const c = Math.pow(Math.max(rho * qr, 0), 0.525);
            const denom = 5.4e5 + 2.55e6 / Math.max(p * qs, 1);
            const erate =
              (phys.rainEvaporation * ((1 - qv / qs) * c)) / (rho * denom);
            const dq = Math.min(
              Math.max(erate * dt, 0),
              Math.min(qr, Math.max(qs - qv, 0))
            );
            qr -= dq;
            f.qvp[n] += dq;
            f.thp[n] -= ((Lv / cp) * dq) / pi;
          }
        }
        f.qc[n] = Math.max(qc, 0);
        f.qr[n] = Math.max(qr, 0);
      }
    }
  }

  // --- sedimentation of rain, upstream with CFL substepping ---
  const dz = base.dz;
  const vt = new Float64Array(nz);
  let vmax = 0;
  const flux = new Float64Array(nz + 1);
  let surfaceMass = 0;

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      // Terminal fall speed per level for this column.
      vmax = 0;
      let any = false;
      for (let k = 0; k < nz; k++) {
        const qr = f.qr[i + nx * (j + ny * k)];
        if (qr > 1e-9) {
          any = true;
          const rho = base.rho[k];
          vt[k] =
            phys.rainFallSpeed *
            36.34 *
            Math.pow(rho * qr, 0.1364) *
            Math.sqrt(rho0 / rho);
          if (vt[k] > vmax) vmax = vt[k];
        } else {
          vt[k] = 0;
        }
      }
      if (!any) continue;

      const nsub = Math.max(1, Math.ceil((vmax * dt) / (0.8 * dz)));
      const dts = dt / nsub;
      for (let s = 0; s < nsub; s++) {
        // Downward mass flux rho*qr*Vt at the bottom face of each cell.
        for (let k = 0; k < nz; k++) {
          const n = i + nx * (j + ny * k);
          flux[k] = base.rho[k] * f.qr[n] * vt[k];
        }
        flux[nz] = 0;
        for (let k = 0; k < nz; k++) {
          const n = i + nx * (j + ny * k);
          const inflow = flux[k + 1];
          const outflow = flux[k];
          f.qr[n] = Math.max(
            f.qr[n] + (dts * (inflow - outflow)) / (base.rho[k] * dz),
            0
          );
        }
        // flux[0] leaves the domain as surface precipitation [kg/m2/s].
        const m = flux[0] * dts;
        f.rainAccum[i + nx * j] += m; // 1 kg/m2 == 1 mm
        surfaceMass += m;
        // Refresh fall speeds between substeps.
        for (let k = 0; k < nz; k++) {
          const qr = f.qr[i + nx * (j + ny * k)];
          const rho = base.rho[k];
          vt[k] =
            qr > 1e-9
              ? phys.rainFallSpeed *
                36.34 *
                Math.pow(rho * qr, 0.1364) *
                Math.sqrt(rho0 / rho)
              : 0;
        }
      }
    }
  }

  return { surfaceRainRate: (surfaceMass / nxy / dt) * 3600 };
}
