import { Rd, cp, cv, g, omegaEarth, cpovcv } from "./constants";
import { buildBaseState, type BaseState } from "./sounding";
import { qsat, pressureFromExner } from "./thermo";
import { applyMicrophysics } from "./microphysics";
import type { Config } from "./config";

export interface Diagnostics {
  time: number; // s
  steps: number;
  maxW: number;
  minW: number;
  maxQc: number; // g/kg
  maxQr: number; // g/kg
  maxThetaPert: number; // K
  cloudTop: number; // m
  rainRate: number; // mm/h, domain mean
  maxRainAccum: number; // mm
  cfl: number;
  stable: boolean;
}

/**
 * Non-hydrostatic, fully compressible cloud model on a staggered C-grid.
 *
 * Time integration follows the split-explicit approach of Klemp & Wilhelmson
 * (1978) as reorganised by Wicker & Skamarock (2002): a three-stage Runge-Kutta
 * loop advances the slow (advective, buoyant, diffusive) terms, and acoustic
 * substeps inside each stage carry the fast pressure-velocity coupling.
 *
 * Prognostic variables: u, v, w, Exner perturbation pi', potential temperature
 * perturbation theta', vapour perturbation qv', cloud water qc, rain qr. All
 * perturbations are measured from the hydrostatic base state in `base`.
 */
export class Solver {
  cfg: Config;
  base: BaseState;

  nx = 0;
  ny = 0;
  nz = 0;
  dx = 0;
  dy = 0;
  dz = 0;

  // Prognostic fields.
  u!: Float32Array;
  v!: Float32Array;
  w!: Float32Array;
  pip!: Float32Array;
  thp!: Float32Array;
  qvp!: Float32Array;
  qc!: Float32Array;
  qr!: Float32Array;
  rainAccum!: Float32Array;

  // Saved state at the start of the large step.
  private u0!: Float32Array;
  private v0!: Float32Array;
  private w0!: Float32Array;
  private pip0!: Float32Array;
  private thp0!: Float32Array;
  private qvp0!: Float32Array;
  private qc0!: Float32Array;
  private qr0!: Float32Array;

  // Slow tendencies.
  private tu!: Float32Array;
  private tv!: Float32Array;
  private tw!: Float32Array;
  private tthp!: Float32Array;
  private tqvp!: Float32Array;
  private tqc!: Float32Array;
  private tqr!: Float32Array;

  private km!: Float32Array;
  private pipPrev!: Float32Array;

  time = 0;
  steps = 0;
  private lastRainRate = 0;
  stable = true;

  constructor(cfg: Config) {
    this.cfg = cfg;
    this.base = buildBaseState(cfg);
    this.allocate();
    this.initialise();
  }

  /** Rebuild everything from a (possibly changed) configuration. */
  reconfigure(cfg: Config): void {
    this.cfg = cfg;
    this.base = buildBaseState(cfg);
    this.allocate();
    this.initialise();
  }

  private allocate(): void {
    const { nx, ny, nz, dx, dy, dz } = this.cfg.grid;
    this.nx = nx;
    this.ny = ny;
    this.nz = nz;
    this.dx = dx;
    this.dy = dy;
    this.dz = dz;
    const nc = nx * ny * nz;
    const nw = nx * ny * (nz + 1);
    const mk = (n: number) => new Float32Array(n);
    this.u = mk(nc);
    this.v = mk(nc);
    this.w = mk(nw);
    this.pip = mk(nc);
    this.thp = mk(nc);
    this.qvp = mk(nc);
    this.qc = mk(nc);
    this.qr = mk(nc);
    this.rainAccum = mk(nx * ny);
    this.u0 = mk(nc);
    this.v0 = mk(nc);
    this.w0 = mk(nw);
    this.pip0 = mk(nc);
    this.thp0 = mk(nc);
    this.qvp0 = mk(nc);
    this.qc0 = mk(nc);
    this.qr0 = mk(nc);
    this.tu = mk(nc);
    this.tv = mk(nc);
    this.tw = mk(nw);
    this.tthp = mk(nc);
    this.tqvp = mk(nc);
    this.tqc = mk(nc);
    this.tqr = mk(nc);
    this.km = mk(nc);
    this.pipPrev = mk(nc);
    this.buildIndexTables();
  }

  /** Set the initial condition: base-state wind plus the warm bubble. */
  initialise(): void {
    const { nx, ny, nz, dx, dy } = this;
    const b = this.base;
    const bu = this.cfg.bubble;
    this.u.fill(0);
    this.v.fill(0);
    this.w.fill(0);
    this.pip.fill(0);
    this.thp.fill(0);
    this.qvp.fill(0);
    this.qc.fill(0);
    this.qr.fill(0);
    this.rainAccum.fill(0);
    this.time = 0;
    this.steps = 0;
    this.stable = true;
    this.lastRainRate = 0;

    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const n = i + nx * (j + ny * k);
          this.u[n] = b.u[k];
          this.v[n] = b.v[k];
        }
      }
    }

    if (!bu.enabled) return;
    const x0 = bu.centerX * nx * dx;
    const y0 = bu.centerY * ny * dy;
    const z0 = bu.centerZ;
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const n = i + nx * (j + ny * k);
          const x = (i + 0.5) * dx;
          const y = (j + 0.5) * dy;
          const r = Math.sqrt(
            ((x - x0) / bu.radiusH) ** 2 +
              ((y - y0) / bu.radiusH) ** 2 +
              ((b.z[k] - z0) / bu.radiusV) ** 2
          );
          if (r < 1) {
            const shape = Math.cos((Math.PI / 2) * r) ** 2;
            this.thp[n] += bu.amplitude * shape;
            if (bu.moisten > 0) {
              const p = pressureFromExner(b.pi[k]);
              const T = (b.theta[k] + this.thp[n]) * b.pi[k];
              const target = Math.min(
                b.qv[k] + bu.moisten * qsat(T, p),
                qsat(T, p)
              );
              this.qvp[n] = Math.max(this.qvp[n], target - b.qv[k]);
            }
          }
          if (bu.noise > 0 && b.z[k] < 1000) {
            this.thp[n] += (Math.random() - 0.5) * 2 * bu.noise;
          }
        }
      }
    }
  }


  /** Fastest sound speed in the base state [m/s]. */
  soundSpeed(): number {
    let c = 0;
    for (let k = 0; k < this.nz; k++) {
      const ck = Math.sqrt(cpovcv * Rd * this.base.T[k]);
      if (ck > c) c = ck;
    }
    return c;
  }

  /** Largest acoustic substep that keeps the fast modes stable [s]. */
  maxAcousticDt(): number {
    const { dx, dy, dz } = this;
    const metric = Math.sqrt(1 / (dx * dx) + 1 / (dy * dy) + 1 / (dz * dz));
    return 0.85 / (this.soundSpeed() * metric);
  }

  /**
   * Number of acoustic substeps for a stage of length `dts`. The configured
   * `acousticSteps` sets the target substep length dt/acousticSteps; the count
   * is then scaled with the stage length so the substep stays the same across
   * the three RK stages (which is what keeps the fast modes stable), and is
   * raised further when `autoAcoustic` is on and the target would be unstable.
   */
  private acousticCount(dts: number): number {
    const num = this.cfg.numerics;
    let target = num.dt / Math.max(num.acousticSteps, 1);
    if (num.autoAcoustic) target = Math.min(target, this.maxAcousticDt());
    return Math.max(1, Math.ceil(dts / target - 1e-9));
  }

  // --- index helpers ------------------------------------------------------
  // Precomputed neighbour index tables (periodic or clamped), rebuilt whenever
  // the grid or the boundary condition changes. Hot loops index these instead
  // of calling a wrapper function per cell.
  private ixm2!: Int32Array;
  private ixm1!: Int32Array;
  private ixp1!: Int32Array;
  private ixp2!: Int32Array;
  private jym2!: Int32Array;
  private jym1!: Int32Array;
  private jyp1!: Int32Array;
  private jyp2!: Int32Array;

  private buildIndexTables(): void {
    const { nx, ny } = this;
    const per = this.cfg.numerics.boundary === "periodic";
    const wrap = (i: number, n: number) =>
      per ? ((i % n) + n) % n : i < 0 ? 0 : i >= n ? n - 1 : i;
    this.ixm2 = new Int32Array(nx);
    this.ixm1 = new Int32Array(nx);
    this.ixp1 = new Int32Array(nx);
    this.ixp2 = new Int32Array(nx);
    for (let i = 0; i < nx; i++) {
      this.ixm2[i] = wrap(i - 2, nx);
      this.ixm1[i] = wrap(i - 1, nx);
      this.ixp1[i] = wrap(i + 1, nx);
      this.ixp2[i] = wrap(i + 2, nx);
    }
    this.jym2 = new Int32Array(ny);
    this.jym1 = new Int32Array(ny);
    this.jyp1 = new Int32Array(ny);
    this.jyp2 = new Int32Array(ny);
    for (let j = 0; j < ny; j++) {
      this.jym2[j] = wrap(j - 2, ny);
      this.jym1[j] = wrap(j - 1, ny);
      this.jyp1[j] = wrap(j + 1, ny);
      this.jyp2[j] = wrap(j + 2, ny);
    }
  }

  // --- subgrid mixing -----------------------------------------------------
  private computeKm(): void {
    const { nx, ny, nz, dx, dy, dz } = this;
    const cs = this.cfg.physics.smagorinsky;
    const bg = this.cfg.physics.backgroundDiffusion;
    const delta = Math.cbrt(dx * dy * dz);
    const kmax = (0.2 * Math.min(dx, dy, dz) ** 2) / this.cfg.numerics.dt;
    const u = this.u;
    const v = this.v;
    const w = this.w;
    for (let k = 0; k < nz; k++) {
      const kp = Math.min(k + 1, nz - 1);
      const km1 = Math.max(k - 1, 0);
      const dzk = (kp - km1) * dz || dz;
      for (let j = 0; j < ny; j++) {
        const jp = this.jyp1[j];
        const jm = this.jym1[j];
        for (let i = 0; i < nx; i++) {
          const n = i + nx * (j + ny * k);
          if (cs <= 0) {
            this.km[n] = bg;
            continue;
          }
          const ip = this.ixp1[i];
          const im = this.ixm1[i];
          const layer = nx * ny * k;
          const uc = 0.5 * (u[i + nx * j + layer] + u[ip + nx * j + layer]);
          const ucp = 0.5 * (u[i + nx * jp + layer] + u[ip + nx * jp + layer]);
          const ucm = 0.5 * (u[i + nx * jm + layer] + u[ip + nx * jm + layer]);
          const vc = 0.5 * (v[i + nx * j + layer] + v[i + nx * jp + layer]);
          const vcp = 0.5 * (v[ip + nx * j + layer] + v[ip + nx * jp + layer]);
          const vcm = 0.5 * (v[im + nx * j + layer] + v[im + nx * jp + layer]);
          const wUp = w[i + nx * (j + ny * (k + 1))];
          const wDn = w[i + nx * (j + ny * k)];
          const wc = 0.5 * (wUp + wDn);
          const wcxp = 0.5 * (w[ip + nx * (j + ny * (k + 1))] + w[ip + nx * (j + ny * k)]);
          const wcxm = 0.5 * (w[im + nx * (j + ny * (k + 1))] + w[im + nx * (j + ny * k)]);
          const wcyp = 0.5 * (w[i + nx * (jp + ny * (k + 1))] + w[i + nx * (jp + ny * k)]);
          const wcym = 0.5 * (w[i + nx * (jm + ny * (k + 1))] + w[i + nx * (jm + ny * k)]);
          const ucz =
            0.5 *
            (u[i + nx * j + nx * ny * kp] + u[ip + nx * j + nx * ny * kp] -
              u[i + nx * j + nx * ny * km1] - u[ip + nx * j + nx * ny * km1]);
          const vcz =
            0.5 *
            (v[i + nx * j + nx * ny * kp] + v[i + nx * jp + nx * ny * kp] -
              v[i + nx * j + nx * ny * km1] - v[i + nx * jp + nx * ny * km1]);

          const d11 = (u[ip + nx * j + layer] - u[i + nx * j + layer]) / dx;
          const d22 = (v[i + nx * jp + layer] - v[i + nx * j + layer]) / dy;
          const d33 = (wUp - wDn) / dz;
          const dudy = (ucp - ucm) / (2 * dy);
          const dvdx = (vcp - vcm) / (2 * dx);
          const dudz = ucz / dzk;
          const dwdx = (wcxp - wcxm) / (2 * dx);
          const dvdz = vcz / dzk;
          const dwdy = (wcyp - wcym) / (2 * dy);
          void uc;
          void vc;
          void wc;
          const def2 =
            2 * (d11 * d11 + d22 * d22 + d33 * d33) +
            (dudy + dvdx) ** 2 +
            (dudz + dwdx) ** 2 +
            (dvdz + dwdy) ** 2;
          const kmv = (cs * delta) ** 2 * Math.sqrt(Math.max(def2, 0));
          this.km[n] = Math.min(kmv + bg, kmax);
        }
      }
    }
  }

  /** out += (1/rho) * div(rho * K * grad(phi)), K = km * factor. */
  private addDiffusion(
    phi: Float32Array,
    out: Float32Array,
    factor: number
  ): void {
    const { nx, ny, nz, dx, dy, dz } = this;
    const b = this.base;
    const km = this.km;
    for (let k = 0; k < nz; k++) {
      const rho = b.rho[k];
      for (let j = 0; j < ny; j++) {
        const jp = this.jyp1[j];
        const jm = this.jym1[j];
        for (let i = 0; i < nx; i++) {
          const ip = this.ixp1[i];
          const im = this.ixm1[i];
          const layer = nx * ny * k;
          const n = i + nx * j + layer;
          const nip = ip + nx * j + layer;
          const nim = im + nx * j + layer;
          const njp = i + nx * jp + layer;
          const njm = i + nx * jm + layer;
          const kc = km[n] * factor;
          const kxp = 0.5 * (kc + km[nip] * factor);
          const kxm = 0.5 * (kc + km[nim] * factor);
          const kyp = 0.5 * (kc + km[njp] * factor);
          const kym = 0.5 * (kc + km[njm] * factor);
          let acc =
            (kxp * (phi[nip] - phi[n]) - kxm * (phi[n] - phi[nim])) / (dx * dx) +
            (kyp * (phi[njp] - phi[n]) - kym * (phi[n] - phi[njm])) / (dy * dy);
          // Vertical, zero flux through the top and bottom boundaries.
          let fUp = 0;
          let fDn = 0;
          if (k < nz - 1) {
            const nup = n + nx * ny;
            const kz = 0.5 * (kc + km[nup] * factor);
            fUp = (b.rhoW[k + 1] * kz * (phi[nup] - phi[n])) / dz;
          }
          if (k > 0) {
            const ndn = n - nx * ny;
            const kz = 0.5 * (kc + km[ndn] * factor);
            fDn = (b.rhoW[k] * kz * (phi[n] - phi[ndn])) / dz;
          }
          acc += (fUp - fDn) / (rho * dz);
          out[n] += acc;
        }
      }
    }
  }

  // --- advection ----------------------------------------------------------
  /** Third-order upwind-biased face value (Wicker & Skamarock 2002). */
  private static face3(
    m1: number,
    p0: number,
    p1: number,
    p2: number,
    U: number
  ): number {
    const centred = (7 * (p0 + p1) - (m1 + p2)) / 12;
    const upwind = (p2 - 3 * p1 + 3 * p0 - m1) / 12;
    return centred + (U >= 0 ? upwind : -upwind);
  }

  /** out = -(1/rho) div(rho V phi) for a cell-centred scalar. */
  private advectScalar(phi: Float32Array, out: Float32Array): void {
    const { nx, ny, nz, dx, dy, dz } = this;
    const b = this.base;
    const u = this.u;
    const v = this.v;
    const w = this.w;
    const F = Solver.face3;
    for (let k = 0; k < nz; k++) {
      const rho = b.rho[k];
      const layer = nx * ny * k;
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const n = i + nx * j + layer;
          // x direction: face i is between cells i-1 and i.
          const i0 = i;
          const im1 = this.ixm1[i];
          const im2 = this.ixm2[i];
          const ip1 = this.ixp1[i];
          const ip2 = this.ixp2[i];
          const uL = u[i0 + nx * j + layer];
          const uR = u[ip1 + nx * j + layer];
          const fL =
            uL *
            F(
              phi[im2 + nx * j + layer],
              phi[im1 + nx * j + layer],
              phi[i0 + nx * j + layer],
              phi[ip1 + nx * j + layer],
              uL
            );
          const fR =
            uR *
            F(
              phi[im1 + nx * j + layer],
              phi[i0 + nx * j + layer],
              phi[ip1 + nx * j + layer],
              phi[ip2 + nx * j + layer],
              uR
            );
          // y direction.
          const j0 = j;
          const jm1 = this.jym1[j];
          const jm2 = this.jym2[j];
          const jp1 = this.jyp1[j];
          const jp2 = this.jyp2[j];
          const vL = v[i + nx * j0 + layer];
          const vR = v[i + nx * jp1 + layer];
          const gL =
            vL *
            F(
              phi[i + nx * jm2 + layer],
              phi[i + nx * jm1 + layer],
              phi[i + nx * j0 + layer],
              phi[i + nx * jp1 + layer],
              vL
            );
          const gR =
            vR *
            F(
              phi[i + nx * jm1 + layer],
              phi[i + nx * j0 + layer],
              phi[i + nx * jp1 + layer],
              phi[i + nx * jp2 + layer],
              vR
            );
          // z direction, flux form with base density on the faces.
          const wD = w[i + nx * (j + ny * k)];
          const wU = w[i + nx * (j + ny * (k + 1))];
          let hD = 0;
          let hU = 0;
          if (k > 0) {
            const a = phi[n - nx * ny];
            const c = phi[n];
            if (k > 1 && k < nz - 1) {
              hD = F(phi[n - 2 * nx * ny], a, c, phi[n + nx * ny], wD);
            } else {
              hD = wD >= 0 ? a : c;
            }
            hD *= b.rhoW[k] * wD;
          }
          if (k < nz - 1) {
            const c = phi[n];
            const a = phi[n + nx * ny];
            if (k > 0 && k < nz - 2) {
              hU = F(phi[n - nx * ny], c, a, phi[n + 2 * nx * ny], wU);
            } else {
              hU = wU >= 0 ? c : a;
            }
            hU *= b.rhoW[k + 1] * wU;
          }
          out[n] =
            -((fR - fL) / dx) -
            (gR - gL) / dy -
            (hU - hD) / (rho * dz);
        }
      }
    }
  }

  /** Second-order centred flux-form advection of the momentum components. */
  private advectMomentum(): void {
    const { nx, ny, nz, dx, dy, dz } = this;
    const b = this.base;
    const u = this.u;
    const v = this.v;
    const w = this.w;

    for (let k = 0; k < nz; k++) {
      const layer = nx * ny * k;
      const rho = b.rho[k];
      for (let j = 0; j < ny; j++) {
        const jp = this.jyp1[j];
        const jm = this.jym1[j];
        for (let i = 0; i < nx; i++) {
          const ip = this.ixp1[i];
          const im = this.ixm1[i];
          const n = i + nx * j + layer;
          const nip = ip + nx * j + layer;
          const nim = im + nx * j + layer;
          const njp = i + nx * jp + layer;
          const njm = i + nx * jm + layer;

          // --- u at the left face of cell i ---
          {
            const uE = 0.5 * (u[n] + u[nip]); // centre of cell i
            const uW = 0.5 * (u[nim] + u[n]); // centre of cell i-1
            const fE = uE * 0.5 * (u[n] + u[nip]);
            const fW = uW * 0.5 * (u[nim] + u[n]);
            const vN = 0.5 * (v[i + nx * jp + layer] + v[im + nx * jp + layer]);
            const vS = 0.5 * (v[i + nx * j + layer] + v[im + nx * j + layer]);
            const gN = vN * 0.5 * (u[n] + u[njp]);
            const gS = vS * 0.5 * (u[njm] + u[n]);
            const wU =
              0.5 *
              (w[i + nx * (j + ny * (k + 1))] + w[im + nx * (j + ny * (k + 1))]);
            const wD =
              0.5 * (w[i + nx * (j + ny * k)] + w[im + nx * (j + ny * k)]);
            const uUp = k < nz - 1 ? u[n + nx * ny] : u[n];
            const uDn = k > 0 ? u[n - nx * ny] : u[n];
            const hU = k < nz - 1 ? b.rhoW[k + 1] * wU * 0.5 * (u[n] + uUp) : 0;
            const hD = k > 0 ? b.rhoW[k] * wD * 0.5 * (uDn + u[n]) : 0;
            this.tu[n] =
              -((fE - fW) / dx) - (gN - gS) / dy - (hU - hD) / (rho * dz);
          }
          // --- v at the south face of cell j ---
          {
            const vN = 0.5 * (v[n] + v[njp]);
            const vS = 0.5 * (v[njm] + v[n]);
            const gN = vN * 0.5 * (v[n] + v[njp]);
            const gS = vS * 0.5 * (v[njm] + v[n]);
            const uE = 0.5 * (u[ip + nx * j + layer] + u[ip + nx * jm + layer]);
            const uW = 0.5 * (u[i + nx * j + layer] + u[i + nx * jm + layer]);
            const fE = uE * 0.5 * (v[n] + v[nip]);
            const fW = uW * 0.5 * (v[nim] + v[n]);
            const wU =
              0.5 *
              (w[i + nx * (j + ny * (k + 1))] + w[i + nx * (jm + ny * (k + 1))]);
            const wD =
              0.5 * (w[i + nx * (j + ny * k)] + w[i + nx * (jm + ny * k)]);
            const vUp = k < nz - 1 ? v[n + nx * ny] : v[n];
            const vDn = k > 0 ? v[n - nx * ny] : v[n];
            const hU = k < nz - 1 ? b.rhoW[k + 1] * wU * 0.5 * (v[n] + vUp) : 0;
            const hD = k > 0 ? b.rhoW[k] * wD * 0.5 * (vDn + v[n]) : 0;
            this.tv[n] =
              -((fE - fW) / dx) - (gN - gS) / dy - (hU - hD) / (rho * dz);
          }
        }
      }
    }

    // --- w on the interior vertical faces ---
    for (let k = 1; k < nz; k++) {
      const rhow = b.rhoW[k];
      for (let j = 0; j < ny; j++) {
        const jp = this.jyp1[j];
        const jm = this.jym1[j];
        for (let i = 0; i < nx; i++) {
          const ip = this.ixp1[i];
          const im = this.ixm1[i];
          const nw = i + nx * (j + ny * k);
          const below = nx * ny * (k - 1);
          const above = nx * ny * k;
          const uE = 0.5 * (u[ip + nx * j + below] + u[ip + nx * j + above]);
          const uW = 0.5 * (u[i + nx * j + below] + u[i + nx * j + above]);
          const fE = uE * 0.5 * (w[nw] + w[ip + nx * (j + ny * k)]);
          const fW = uW * 0.5 * (w[im + nx * (j + ny * k)] + w[nw]);
          const vN = 0.5 * (v[i + nx * jp + below] + v[i + nx * jp + above]);
          const vS = 0.5 * (v[i + nx * j + below] + v[i + nx * j + above]);
          const gN = vN * 0.5 * (w[nw] + w[i + nx * (jp + ny * k)]);
          const gS = vS * 0.5 * (w[i + nx * (jm + ny * k)] + w[nw]);
          const wUp = w[i + nx * (j + ny * Math.min(k + 1, nz))];
          const wDn = w[i + nx * (j + ny * (k - 1))];
          const wcU = 0.5 * (w[nw] + wUp);
          const wcD = 0.5 * (wDn + w[nw]);
          const hU = b.rho[k] * wcU * wcU;
          const hD = b.rho[k - 1] * wcD * wcD;
          this.tw[nw] =
            -((fE - fW) / dx) - (gN - gS) / dy - (hU - hD) / (rhow * dz);
        }
      }
    }
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        this.tw[i + nx * j] = 0;
        this.tw[i + nx * (j + ny * nz)] = 0;
      }
  }

  // --- slow tendencies ----------------------------------------------------
  private computeSlowTendencies(): void {
    const { nx, ny, nz, dz } = this;
    const b = this.base;
    const num = this.cfg.numerics;
    const phys = this.cfg.physics;

    this.computeKm();
    this.advectMomentum();

    // Scalars: advect the perturbation and add the base-state vertical advection.
    this.advectScalar(this.thp, this.tthp);
    this.advectScalar(this.qvp, this.tqvp);
    this.advectScalar(this.qc, this.tqc);
    this.advectScalar(this.qr, this.tqr);

    for (let k = 0; k < nz; k++) {
      const kUp = Math.min(k + 1, nz - 1);
      const kDn = Math.max(k - 1, 0);
      const dthdz = (b.theta[kUp] - b.theta[kDn]) / ((kUp - kDn) * dz || dz);
      const dqvdz = (b.qv[kUp] - b.qv[kDn]) / ((kUp - kDn) * dz || dz);
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const n = i + nx * (j + ny * k);
          const wc =
            0.5 *
            (this.w[i + nx * (j + ny * k)] +
              this.w[i + nx * (j + ny * (k + 1))]);
          this.tthp[n] -= wc * dthdz;
          this.tqvp[n] -= wc * dqvdz;
        }
      }
    }

    // Buoyancy on the w faces.
    for (let k = 1; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const nUp = i + nx * (j + ny * k);
          const nDn = nUp - nx * ny;
          const bUp =
            this.thp[nUp] / b.theta[k] +
            0.6078 * this.qvp[nUp] -
            this.qc[nUp] -
            this.qr[nUp];
          const bDn =
            this.thp[nDn] / b.theta[k - 1] +
            0.6078 * this.qvp[nDn] -
            this.qc[nDn] -
            this.qr[nDn];
          this.tw[nUp] += g * 0.5 * (bUp + bDn);
        }
      }
    }

    // Coriolis on the perturbation wind.
    if (phys.coriolis) {
      const f = 2 * omegaEarth * Math.sin((phys.latitude * Math.PI) / 180);
      for (let k = 0; k < nz; k++) {
        for (let j = 0; j < ny; j++) {
          for (let i = 0; i < nx; i++) {
            const n = i + nx * (j + ny * k);
            this.tu[n] += f * (this.v[n] - b.v[k]);
            this.tv[n] -= f * (this.u[n] - b.u[k]);
          }
        }
      }
    }

    // Subgrid mixing of the perturbations.
    const prandtl = 1 / 3;
    const scratchU = this.scratch(nx * ny * nz, 0);
    const scratchV = this.scratch(nx * ny * nz, 1);
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const n = i + nx * (j + ny * k);
          scratchU[n] = this.u[n] - b.u[k];
          scratchV[n] = this.v[n] - b.v[k];
        }
    this.addDiffusion(scratchU, this.tu, 1);
    this.addDiffusion(scratchV, this.tv, 1);
    this.addDiffusion(this.thp, this.tthp, 1 / prandtl);
    this.addDiffusion(this.qvp, this.tqvp, 1 / prandtl);
    this.addDiffusion(this.qc, this.tqc, 1 / prandtl);
    this.addDiffusion(this.qr, this.tqr, 1 / prandtl);

    // Surface drag.
    if (phys.surfaceDrag > 0) {
      const cd = phys.surfaceDrag;
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const n = i + nx * j;
          const spd = Math.hypot(this.u[n], this.v[n]);
          this.tu[n] -= (cd * spd * this.u[n]) / dz;
          this.tv[n] -= (cd * spd * this.v[n]) / dz;
        }
      }
    }

    // Rayleigh sponge in the upper part of the domain.
    const ztop = nz * dz;
    const zs = ztop - num.rayleighDepth;
    if (num.rayleighDepth > 0 && num.rayleighRate > 0) {
      for (let k = 0; k < nz; k++) {
        if (b.z[k] < zs) continue;
        const f =
          num.rayleighRate *
          Math.sin((Math.PI / 2) * ((b.z[k] - zs) / num.rayleighDepth)) ** 2;
        for (let j = 0; j < ny; j++) {
          for (let i = 0; i < nx; i++) {
            const n = i + nx * (j + ny * k);
            this.tu[n] -= f * (this.u[n] - b.u[k]);
            this.tv[n] -= f * (this.v[n] - b.v[k]);
            this.tthp[n] -= f * this.thp[n];
            const nw = i + nx * (j + ny * k);
            this.tw[nw] -= f * this.w[nw];
          }
        }
      }
    }
  }

  private scratchPool: Float32Array[] = [];
  private scratch(n: number, slot: number): Float32Array {
    let a = this.scratchPool[slot];
    if (!a || a.length !== n) {
      a = new Float32Array(n);
      this.scratchPool[slot] = a;
    }
    return a;
  }

  // --- acoustic substeps --------------------------------------------------
  private acoustic(dts: number, ns: number): void {
    const { nx, ny, nz, dx, dy, dz } = this;
    const b = this.base;
    const alpha = this.cfg.numerics.divergenceDamping;
    const dtau = dts / ns;
    this.u.set(this.u0);
    this.v.set(this.v0);
    this.w.set(this.w0);
    this.pip.set(this.pip0);
    this.pipPrev.set(this.pip0);

    for (let s = 0; s < ns; s++) {
      // Momentum, forward step with the pressure gradient (plus divergence damping).
      for (let k = 0; k < nz; k++) {
        const layer = nx * ny * k;
        const cpth = cp * b.thetaV[k];
        for (let j = 0; j < ny; j++) {
          for (let i = 0; i < nx; i++) {
            const n = i + nx * j + layer;
            const im = this.ixm1[i] + nx * j + layer;
            const jm = i + nx * this.jym1[j] + layer;
            const pC = this.pip[n] + alpha * (this.pip[n] - this.pipPrev[n]);
            const pX = this.pip[im] + alpha * (this.pip[im] - this.pipPrev[im]);
            const pY = this.pip[jm] + alpha * (this.pip[jm] - this.pipPrev[jm]);
            this.u[n] += dtau * (this.tu[n] - (cpth * (pC - pX)) / dx);
            this.v[n] += dtau * (this.tv[n] - (cpth * (pC - pY)) / dy);
          }
        }
      }
      for (let k = 1; k < nz; k++) {
        const cpth = cp * b.thetaVW[k];
        for (let j = 0; j < ny; j++) {
          for (let i = 0; i < nx; i++) {
            const nw = i + nx * (j + ny * k);
            const nUp = i + nx * (j + ny * k);
            const nDn = nUp - nx * ny;
            const pU =
              this.pip[nUp] + alpha * (this.pip[nUp] - this.pipPrev[nUp]);
            const pD =
              this.pip[nDn] + alpha * (this.pip[nDn] - this.pipPrev[nDn]);
            this.w[nw] += dtau * (this.tw[nw] - (cpth * (pU - pD)) / dz);
          }
        }
      }

      // Pressure, backward step from the updated mass divergence.
      this.pipPrev.set(this.pip);
      for (let k = 0; k < nz; k++) {
        const layer = nx * ny * k;
        const rho = b.rho[k];
        const thv = b.thetaV[k];
        const coef = (Rd * b.pi[k]) / (cv * rho * thv);
        for (let j = 0; j < ny; j++) {
          const jp = this.jyp1[j];
          for (let i = 0; i < nx; i++) {
            const ip = this.ixp1[i];
            const n = i + nx * j + layer;
            const du = (this.u[ip + nx * j + layer] - this.u[n]) / dx;
            const dv = (this.v[i + nx * jp + layer] - this.v[n]) / dy;
            const mUp =
              b.rhoW[k + 1] * b.thetaVW[k + 1] * this.w[i + nx * (j + ny * (k + 1))];
            const mDn =
              b.rhoW[k] * b.thetaVW[k] * this.w[i + nx * (j + ny * k)];
            const div = rho * thv * (du + dv) + (mUp - mDn) / dz;
            this.pip[n] -= dtau * coef * div;
          }
        }
      }
    }
  }

  /** Advance the model by one large time step. */
  step(): void {
    if (!this.stable) return;
    const num = this.cfg.numerics;
    const dt = num.dt;
    this.buildIndexTables();
    this.u0.set(this.u);
    this.v0.set(this.v);
    this.w0.set(this.w);
    this.pip0.set(this.pip);
    this.thp0.set(this.thp);
    this.qvp0.set(this.qvp);
    this.qc0.set(this.qc);
    this.qr0.set(this.qr);

    const stageDt = [dt / 3, dt / 2, dt];
    for (let s = 0; s < 3; s++) {
      const dts = stageDt[s];
      this.computeSlowTendencies();
      const ns = this.acousticCount(dts);
      this.acoustic(dts, ns);
      const n = this.thp.length;
      for (let m = 0; m < n; m++) {
        this.thp[m] = this.thp0[m] + dts * this.tthp[m];
        this.qvp[m] = this.qvp0[m] + dts * this.tqvp[m];
        this.qc[m] = Math.max(this.qc0[m] + dts * this.tqc[m], 0);
        this.qr[m] = Math.max(this.qr0[m] + dts * this.tqr[m], 0);
      }
    }

    const res = applyMicrophysics(
      {
        nx: this.nx,
        ny: this.ny,
        nz: this.nz,
        thp: this.thp,
        qvp: this.qvp,
        qc: this.qc,
        qr: this.qr,
        pip: this.pip,
        rainAccum: this.rainAccum,
      },
      this.base,
      this.cfg.physics,
      dt
    );
    this.lastRainRate = res.surfaceRainRate;

    this.time += dt;
    this.steps += 1;
  }

  // --- diagnostics --------------------------------------------------------
  diagnostics(): Diagnostics {
    const { nx, ny, nz, dx, dy, dz } = this;
    let maxW = 0;
    let minW = 0;
    let maxQc = 0;
    let maxQr = 0;
    let maxTh = 0;
    let cloudTop = 0;
    let maxU = 0;
    let bad = false;
    for (let m = 0; m < this.w.length; m++) {
      const x = this.w[m];
      if (!isFinite(x)) {
        bad = true;
        break;
      }
      if (x > maxW) maxW = x;
      if (x < minW) minW = x;
    }
    for (let k = 0; k < nz && !bad; k++) {
      let layerCloud = false;
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const n = i + nx * (j + ny * k);
          const qc = this.qc[n];
          const qr = this.qr[n];
          const th = Math.abs(this.thp[n]);
          if (!isFinite(qc) || !isFinite(th)) {
            bad = true;
            break;
          }
          if (qc > maxQc) maxQc = qc;
          if (qr > maxQr) maxQr = qr;
          if (th > maxTh) maxTh = th;
          if (qc > 1e-5) layerCloud = true;
          const sp = Math.max(Math.abs(this.u[n]), Math.abs(this.v[n]));
          if (sp > maxU) maxU = sp;
        }
      }
      if (layerCloud) cloudTop = this.base.zw[k + 1];
    }
    let maxRain = 0;
    for (let m = 0; m < this.rainAccum.length; m++)
      if (this.rainAccum[m] > maxRain) maxRain = this.rainAccum[m];

    if (bad || maxW > 300 || maxTh > 100) this.stable = false;

    const cfl =
      (this.cfg.numerics.dt *
        (maxU / dx + maxU / dy + Math.max(maxW, -minW) / dz)) /
      1;
    return {
      time: this.time,
      steps: this.steps,
      maxW,
      minW,
      maxQc: maxQc * 1e3,
      maxQr: maxQr * 1e3,
      maxThetaPert: maxTh,
      cloudTop,
      rainRate: this.lastRainRate,
      maxRainAccum: maxRain,
      cfl,
      stable: this.stable,
    };
  }

  /** Total water field in g/kg for rendering: cloud, rain, both, or updraft. */
  sampleField(field: "cloud" | "rain" | "total" | "updraft", out: Float32Array): void {
    const { nx, ny, nz } = this;
    const n = nx * ny * nz;
    if (field === "updraft") {
      for (let k = 0; k < nz; k++)
        for (let j = 0; j < ny; j++)
          for (let i = 0; i < nx; i++) {
            const m = i + nx * (j + ny * k);
            out[m] =
              0.5 *
              (this.w[i + nx * (j + ny * k)] +
                this.w[i + nx * (j + ny * (k + 1))]);
          }
      return;
    }
    for (let m = 0; m < n; m++) {
      const qc = this.qc[m];
      const qr = this.qr[m];
      out[m] =
        field === "cloud" ? qc * 1e3 : field === "rain" ? qr * 1e3 : (qc + qr) * 1e3;
    }
  }
}
