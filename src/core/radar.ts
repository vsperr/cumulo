/**
 * Radar reflectivity, as a real radar would see this storm.
 *
 * For an exponential (Marshall-Palmer) raindrop size distribution, which is
 * what the Kessler scheme assumes, the radar reflectivity factor follows the
 * rain water content directly:
 *
 *     Z = 3.63e9 * (rho * qr)^1.75      [mm^6 / m^3],  rho*qr in kg/m^3
 *     dBZ = 10 log10(Z)
 *
 * which puts 0.1 g/m^3 of rain near 26 dBZ, 1 g/m^3 near 43 dBZ and 5 g/m^3
 * near 55 dBZ — the familiar numbers off a weather radar.
 *
 * This is the same diagnostic relation CM1 and WRF use for their Kessler
 * reflectivity output. It sees rain only: cloud droplets are far too small to
 * return a signal, which is why a growing tower is invisible to radar until it
 * starts making raindrops.
 */

/** Reflectivity in dBZ from air density and rain mixing ratio. */
export function reflectivityDbz(rho: number, qr: number): number {
  const m = rho * qr; // rain water content, kg/m^3
  if (m <= 1e-12) return -35;
  const z = 3.63e9 * Math.pow(m, 1.75);
  return 10 * Math.log10(Math.max(z, 1e-4));
}

/** Lowest reflectivity a radar would plot; below this the scope is empty. */
export const DBZ_FLOOR = 5;
export const DBZ_CEIL = 75;

export interface ScaleStop {
  dbz: number;
  rgb: [number, number, number];
}

/**
 * The standard weather-radar colour table in 5 dBZ steps. Deliberately a step
 * scale, not a gradient: every radar product people are used to reading is
 * banded, and a band edge is information.
 */
export const RADAR_SCALE: ScaleStop[] = [
  { dbz: 5, rgb: [4, 233, 231] },
  { dbz: 10, rgb: [1, 159, 244] },
  { dbz: 15, rgb: [3, 0, 244] },
  { dbz: 20, rgb: [2, 253, 2] },
  { dbz: 25, rgb: [1, 197, 1] },
  { dbz: 30, rgb: [0, 142, 0] },
  { dbz: 35, rgb: [253, 248, 2] },
  { dbz: 40, rgb: [229, 188, 0] },
  { dbz: 45, rgb: [253, 149, 0] },
  { dbz: 50, rgb: [253, 0, 0] },
  { dbz: 55, rgb: [212, 0, 0] },
  { dbz: 60, rgb: [188, 0, 0] },
  { dbz: 65, rgb: [248, 0, 253] },
  { dbz: 70, rgb: [152, 84, 198] },
  { dbz: 75, rgb: [255, 255, 255] },
];

/** Colour for a reflectivity value, or null when it is below the floor. */
export function radarColor(dbz: number): [number, number, number] | null {
  if (dbz < DBZ_FLOOR) return null;
  let pick = RADAR_SCALE[0];
  for (const s of RADAR_SCALE) if (dbz >= s.dbz) pick = s;
  return pick.rgb;
}

export function radarCss(dbz: number): string | null {
  const c = radarColor(dbz);
  return c ? `rgb(${c[0]},${c[1]},${c[2]})` : null;
}

/**
 * The continuous rainbow CM1 output is conventionally plotted with in VisIt:
 * dark blue through cyan, green, yellow, red to magenta. Unlike the banded
 * operational table this one is a smooth ramp, which is what makes a CM1
 * reflectivity figure recognisable at a glance.
 */
const CM1_STOPS: [number, [number, number, number]][] = [
  [-10, [0, 0, 140]],
  [0, [0, 115, 255]],
  [10, [0, 230, 242]],
  [20, [26, 217, 51]],
  [30, [140, 242, 26]],
  [40, [255, 242, 0]],
  [50, [255, 115, 0]],
  [60, [242, 0, 0]],
  [70, [217, 0, 191]],
  [80, [255, 191, 242]],
];

export function cm1Color(dbz: number): [number, number, number] {
  if (dbz <= CM1_STOPS[0][0]) return CM1_STOPS[0][1];
  for (let i = 1; i < CM1_STOPS.length; i++) {
    const [d1, c1] = CM1_STOPS[i];
    if (dbz <= d1) {
      const [d0, c0] = CM1_STOPS[i - 1];
      const t = (dbz - d0) / (d1 - d0);
      return [
        Math.round(c0[0] + t * (c1[0] - c0[0])),
        Math.round(c0[1] + t * (c1[1] - c0[1])),
        Math.round(c0[2] + t * (c1[2] - c0[2])),
      ];
    }
  }
  return CM1_STOPS[CM1_STOPS.length - 1][1];
}

/** Lowest value the CM1-style plots colour; below it the field reads as empty. */
export const CM1_FLOOR = -10;

/** Plain-language description of a reflectivity value. */
export function describeDbz(dbz: number): string {
  if (dbz < 5) return "no echo";
  if (dbz < 20) return "drizzle or cloud edge";
  if (dbz < 35) return "light to moderate rain";
  if (dbz < 45) return "heavy rain";
  if (dbz < 55) return "very heavy rain, possible hail";
  if (dbz < 65) return "severe core, hail likely";
  return "extreme — large hail";
}
