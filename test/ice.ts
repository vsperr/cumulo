/**
 * Side-by-side run with the ice phase on and off. The point is not that the
 * numbers are pretty but that the differences are the ones ice is supposed to
 * make: a taller storm, an anvil that survives, a colder cold pool, stronger
 * reflectivity, and frozen precipitation.
 */
import { defaultConfig } from "../src/core/config";
import { Solver } from "../src/core/solver";
import { reflectivityDbz } from "../src/core/radar";

const minutes = Number(process.argv[2] ?? 45);
const nx = Number(process.argv[3] ?? 32);
const nz = Number(process.argv[4] ?? 40);

interface Snap {
  t: number;
  maxW: number;
  minW: number;
  top: number;
  anvilArea: number;
  coldPool: number;
  maxDbz: number;
  rain: number;
  snow: number;
  qi: number;
  qs: number;
  qg: number;
}

function run(ice: boolean): Snap[] {
  const cfg = defaultConfig();
  cfg.grid.nx = nx;
  cfg.grid.ny = nx;
  cfg.grid.nz = nz;
  cfg.physics.ice = ice;
  cfg.bubble.noise = 0;
  const s = new Solver(cfg);
  const total = Math.round((minutes * 60) / cfg.numerics.dt);
  const every = Math.round((5 * 60) / cfg.numerics.dt);
  const out: Snap[] = [];

  for (let n = 1; n <= total; n++) {
    s.step();
    if (n % every) continue;
    const d = s.diagnostics();

    // Anvil: cells with condensate above 8 km, as a fraction of that layer.
    let anvil = 0;
    let cells = 0;
    for (let k = 0; k < s.nz; k++) {
      if (s.base.z[k] < 8000) continue;
      for (let m = 0; m < s.nx * s.ny; m++) {
        const idx = m + s.nx * s.ny * k;
        cells++;
        if (s.qc[idx] + s.qi[idx] + s.qs[idx] > 1e-6) anvil++;
      }
    }

    // Cold pool: coldest potential-temperature perturbation in the lowest 500 m.
    let cold = 0;
    for (let k = 0; k < s.nz && s.base.z[k] < 500; k++)
      for (let m = 0; m < s.nx * s.ny; m++) {
        const v = s.thp[m + s.nx * s.ny * k];
        if (v < cold) cold = v;
      }

    let maxDbz = -99;
    for (let k = 0; k < s.nz; k++)
      for (let m = 0; m < s.nx * s.ny; m++) {
        const idx = m + s.nx * s.ny * k;
        const T = (s.base.theta[k] + s.thp[idx]) * (s.base.pi[k] + s.pip[idx]);
        const z = reflectivityDbz(s.base.rho[k], s.qr[idx], s.qs[idx], s.qg[idx], T);
        if (z > maxDbz) maxDbz = z;
      }

    out.push({
      t: d.time / 60,
      maxW: d.maxW,
      minW: d.minW,
      top: d.cloudTop / 1000,
      anvilArea: cells ? (100 * anvil) / cells : 0,
      coldPool: cold,
      maxDbz,
      rain: d.maxRainAccum,
      snow: d.maxSnowAccum,
      qi: d.maxQi,
      qs: d.maxQs,
      qg: d.maxQg,
    });
    if (!d.stable) {
      console.log(`  UNSTABLE at ${(d.time / 60).toFixed(1)} min`);
      break;
    }
  }
  return out;
}

const t0 = Date.now();
const warm = run(false);
const tWarm = Date.now() - t0;
const t1 = Date.now();
const cold = run(true);
const tIce = Date.now() - t1;

console.log(`grid ${nx}x${nx}x${nz}, ${minutes} min\n`);
console.log("            |        warm rain only        |          with ice");
console.log("  t[min]    |  maxW   top   anvil%  cold   |  maxW   top   anvil%  cold   qi    qs    qg   dBZ");
for (let i = 0; i < Math.max(warm.length, cold.length); i++) {
  const w = warm[i];
  const c = cold[i];
  if (!w || !c) break;
  console.log(
    [
      w.t.toFixed(0).padStart(7),
      "   |",
      w.maxW.toFixed(1).padStart(6),
      w.top.toFixed(1).padStart(6),
      w.anvilArea.toFixed(1).padStart(6),
      w.coldPool.toFixed(1).padStart(6),
      "  |",
      c.maxW.toFixed(1).padStart(6),
      c.top.toFixed(1).padStart(6),
      c.anvilArea.toFixed(1).padStart(6),
      c.coldPool.toFixed(1).padStart(6),
      c.qi.toFixed(2).padStart(5),
      c.qs.toFixed(2).padStart(5),
      c.qg.toFixed(2).padStart(5),
      c.maxDbz.toFixed(0).padStart(4),
    ].join(" ")
  );
}
const lw = warm[warm.length - 1];
const lc = cold[cold.length - 1];
if (lw && lc) {
  console.log("\nat the end:");
  console.log(`  cloud top     ${lw.top.toFixed(1)} -> ${lc.top.toFixed(1)} km`);
  console.log(`  anvil cover   ${lw.anvilArea.toFixed(1)} -> ${lc.anvilArea.toFixed(1)} %`);
  console.log(`  cold pool     ${lw.coldPool.toFixed(1)} -> ${lc.coldPool.toFixed(1)} K`);
  console.log(`  peak dBZ      ${lw.maxDbz.toFixed(0)} -> ${lc.maxDbz.toFixed(0)}`);
  console.log(`  surface rain  ${lw.rain.toFixed(0)} -> ${lc.rain.toFixed(0)} mm, frozen ${lc.snow.toFixed(1)} mm`);
}
console.log(
  `\ncost: warm ${(tWarm / 1000).toFixed(1)} s, ice ${(tIce / 1000).toFixed(1)} s  (${(
    tIce / tWarm
  ).toFixed(2)}x)`
);
