/**
 * Headless run: integrates the model and prints diagnostics, so the physics can
 * be checked without a browser.  Usage: npm run sim -- [minutes] [nx] [nz]
 */
import { defaultConfig } from "../src/core/config";
import { Solver } from "../src/core/solver";
import { parcelAscent, bulkShear } from "../src/core/thermo";

const minutes = Number(process.argv[2] ?? 30);
const nx = Number(process.argv[3] ?? 40);
const nz = Number(process.argv[4] ?? 40);

const cfg = defaultConfig();
cfg.grid.nx = nx;
cfg.grid.ny = nx;
cfg.grid.nz = nz;
cfg.bubble.noise = 0;

const solver = new Solver(cfg);
const b = solver.base;

const diag = parcelAscent(b.z, b.p, b.theta, b.qv);
console.log("=== base state ===");
console.log(
  `domain      ${(nx * cfg.grid.dx) / 1000} x ${(nx * cfg.grid.dy) / 1000} x ${
    (nz * cfg.grid.dz) / 1000
  } km   dx=${cfg.grid.dx} m dz=${cfg.grid.dz} m`
);
console.log(
  `surface     p=${b.p[0].toFixed(0)} Pa  T=${(b.T[0] - 273.15).toFixed(
    1
  )} C  qv=${(b.qv[0] * 1e3).toFixed(2)} g/kg`
);
console.log(
  `CAPE        ${diag.cape.toFixed(0)} J/kg   CIN ${diag.cin.toFixed(
    0
  )} J/kg   LCL ${diag.lclZ.toFixed(0)} m   LFC ${diag.lfcZ.toFixed(0)} m   EL ${diag.elZ.toFixed(0)} m`
);
console.log(
  `shear 0-6km ${bulkShear(b.z, b.u, b.v, 6000).toFixed(1)} m/s   PWAT ${diag.pwat.toFixed(1)} mm`
);

const totalSteps = Math.round((minutes * 60) / cfg.numerics.dt);
const report = Math.max(1, Math.round(totalSteps / 15));
console.log("\n=== integration ===");
console.log("  t[min]   maxW   minW   maxQc  maxQr  maxTh  top[km]  rain[mm]  CFL");
const t0 = Date.now();
for (let s = 1; s <= totalSteps; s++) {
  solver.step();
  if (s % report === 0 || s === totalSteps) {
    const d = solver.diagnostics();
    console.log(
      [
        (d.time / 60).toFixed(1).padStart(7),
        d.maxW.toFixed(2).padStart(7),
        d.minW.toFixed(2).padStart(7),
        d.maxQc.toFixed(3).padStart(7),
        d.maxQr.toFixed(3).padStart(6),
        d.maxThetaPert.toFixed(2).padStart(6),
        (d.cloudTop / 1000).toFixed(2).padStart(8),
        d.maxRainAccum.toFixed(3).padStart(9),
        d.cfl.toFixed(2).padStart(5),
      ].join(" ")
    );
    if (!d.stable) {
      console.log("UNSTABLE - aborting");
      break;
    }
  }
}
const dtms = Date.now() - t0;
console.log(
  `\n${totalSteps} steps in ${(dtms / 1000).toFixed(1)} s  (${(
    dtms / totalSteps
  ).toFixed(1)} ms/step, ${((totalSteps * cfg.numerics.dt) / (dtms / 1000)).toFixed(
    0
  )}x realtime)`
);
