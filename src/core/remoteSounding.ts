import { Rd, cp, p00, eps } from "./constants";
import { esat, qsat, parcelAscent } from "./thermo";
import type { SoundingLevel } from "./config";

/**
 * Real soundings, pulled from numerical weather prediction models through the
 * Open-Meteo API (open-meteo.com, CC-BY-4.0, no key required). Pick a point on
 * the map, pick a model, pick an hour, and the forecast column becomes the
 * model's initial condition.
 */

export interface RemoteModel {
  id: string;
  name: string;
  note: string;
}

export const MODELS: RemoteModel[] = [
  { id: "icon_seamless", name: "ICON (DWD)", note: "German weather service, global blended with the 2 km nest over central Europe" },
  { id: "icon_d2", name: "ICON-D2", note: "2 km convection-permitting nest, central Europe only" },
  { id: "icon_eu", name: "ICON-EU", note: "7 km over Europe" },
  { id: "icon_global", name: "ICON global", note: "11 km worldwide" },
  { id: "ecmwf_ifs025", name: "ECMWF IFS", note: "European Centre, 25 km worldwide" },
  { id: "gfs_seamless", name: "GFS (NOAA)", note: "US global model with the 3 km HRRR nest over North America" },
  { id: "meteofrance_arpege_europe", name: "ARPEGE Europe", note: "Météo-France, 11 km" },
  { id: "ukmo_seamless", name: "UKMO", note: "UK Met Office" },
  { id: "gem_global", name: "GEM (Canada)", note: "Environment Canada" },
  { id: "jma_seamless", name: "JMA (Japan)", note: "Japan Meteorological Agency" },
];

/** Pressure levels Open-Meteo serves, hPa. */
const LEVELS = [
  1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150,
  100, 70, 50, 30,
];
const PER_LEVEL = [
  "temperature",
  "relative_humidity",
  "wind_speed",
  "wind_direction",
  "geopotential_height",
];
const SURFACE = [
  "surface_pressure",
  "temperature_2m",
  "dew_point_2m",
  "wind_speed_10m",
  "wind_direction_10m",
];

type Hourly = Record<string, (number | null)[]> & { time: string[] };

export interface RemoteColumn {
  model: string;
  modelName: string;
  lat: number;
  lon: number;
  /** Terrain height of the model grid cell [m]. */
  elevation: number;
  /** ISO timestamps, one per available hour. */
  times: string[];
  hourly: Hourly;
}

export interface RemoteSounding {
  levels: SoundingLevel[];
  psfc: number; // hPa
  time: string;
  elevation: number;
  /** Levels that were dropped because they sit below the terrain. */
  skippedBelowGround: number;
  /**
   * Convective indices of the source sounding at its native resolution.
   * The model's own grid resolves less than this: a 400 m vertical spacing
   * smooths the profile and typically loses a quarter to a third of the CAPE,
   * and a domain shorter than `sourceEl` cuts the top off the positive area.
   * Showing both numbers makes that cost visible instead of silent.
   */
  sourceCape: number;
  sourceLcl: number;
  sourceEl: number;
}

function buildUrl(lat: number, lon: number, model: string, days: number): string {
  const hourly = [
    ...SURFACE,
    ...LEVELS.flatMap((L) => PER_LEVEL.map((v) => `${v}_${L}hPa`)),
  ].join(",");
  const q = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    hourly,
    models: model,
    wind_speed_unit: "ms",
    forecast_days: String(days),
  });
  return `https://api.open-meteo.com/v1/forecast?${q.toString()}`;
}

/**
 * Download the forecast column for one point. The whole time range comes down
 * in a single request so the hour can be scrubbed without hitting the network
 * again.
 */
export async function fetchColumn(
  lat: number,
  lon: number,
  model: string,
  days = 2,
  signal?: AbortSignal
): Promise<RemoteColumn> {
  const res = await fetch(buildUrl(lat, lon, model, days), { signal });
  const body = (await res.json()) as {
    error?: boolean;
    reason?: string;
    latitude: number;
    longitude: number;
    elevation: number;
    hourly: Hourly;
  };
  if (!res.ok || body.error)
    throw new Error(body.reason ?? `request failed (${res.status})`);
  if (!body.hourly?.time?.length) throw new Error("no data for this point");
  return {
    model,
    modelName: MODELS.find((m) => m.id === model)?.name ?? model,
    lat: body.latitude,
    lon: body.longitude,
    elevation: body.elevation,
    times: body.hourly.time,
    hourly: body.hourly,
  };
}

/** Potential temperature from Celsius and hPa. */
function thetaOf(tC: number, pHpa: number): number {
  const T = tC + 273.15;
  return T * Math.pow(p00 / (pHpa * 100), Rd / cp);
}

/** Wind components from meteorological speed and direction (whence it blows). */
function uvOf(speed: number, dirDeg: number): [number, number] {
  const r = (dirDeg * Math.PI) / 180;
  return [-speed * Math.sin(r), -speed * Math.cos(r)];
}

/**
 * Turn one hour of a downloaded column into a level table the model can start
 * from. Heights become above-ground-level, relative humidity becomes a mixing
 * ratio, and wind speed and direction become u and v. Pressure levels that lie
 * below the model's terrain are dropped.
 */
export function soundingAt(col: RemoteColumn, hour: number): RemoteSounding {
  const h = col.hourly;
  const i = Math.max(0, Math.min(hour, col.times.length - 1));
  const num = (key: string): number | null => {
    const v = h[key]?.[i];
    return typeof v === "number" && isFinite(v) ? v : null;
  };

  const psfc = num("surface_pressure") ?? 1013.25;
  const levels: SoundingLevel[] = [];
  /** Pressure [hPa] of each entry in `levels`, kept parallel to it. */
  const pressureOf: number[] = [];

  // Surface level, from the 2 m and 10 m fields.
  const t2 = num("temperature_2m");
  const td2 = num("dew_point_2m");
  if (t2 !== null) {
    const e = esat((td2 ?? t2) + 273.15);
    const qv = ((eps * e) / Math.max(psfc * 100 - e, 1)) * 1e3;
    const [u, v] = uvOf(num("wind_speed_10m") ?? 0, num("wind_direction_10m") ?? 0);
    levels.push({ z: 0, theta: thetaOf(t2, psfc), qv, u, v });
    pressureOf.push(psfc);
  }

  let skipped = 0;
  for (const L of LEVELS) {
    const t = num(`temperature_${L}hPa`);
    const gz = num(`geopotential_height_${L}hPa`);
    if (t === null || gz === null) continue;
    const z = gz - col.elevation;
    if (z <= 10) {
      skipped++;
      continue; // below (or level with) the terrain
    }
    const rh = (num(`relative_humidity_${L}hPa`) ?? 0) / 100;
    const qv = rh * qsat(t + 273.15, L * 100) * 1e3;
    const [u, v] = uvOf(
      num(`wind_speed_${L}hPa`) ?? 0,
      num(`wind_direction_${L}hPa`) ?? 0
    );
    levels.push({ z, theta: thetaOf(t, L), qv, u, v });
    pressureOf.push(L);
  }

  const order = levels.map((_, n) => n).sort((a, b) => levels[a].z - levels[b].z);
  const sortedLevels = order.map((n) => levels[n]);
  const sortedPressure = order.map((n) => pressureOf[n]);
  levels.length = 0;
  levels.push(...sortedLevels);
  pressureOf.length = 0;
  pressureOf.push(...sortedPressure);
  // Drop duplicate or inverted heights, which the interpolator cannot use.
  const clean: SoundingLevel[] = [];
  const press: number[] = [];
  for (let n = 0; n < levels.length; n++) {
    const lv = levels[n];
    if (clean.length === 0 || lv.z > clean[clean.length - 1].z + 1) {
      clean.push(lv);
      press.push(pressureOf[n]);
    }
  }

  // Indices at the sounding's own resolution, before the model grid sees it.
  const zs = Float64Array.from(clean.map((l) => l.z));
  const ps = Float64Array.from(press.map((hpa) => hpa * 100));
  const ths = Float64Array.from(clean.map((l) => l.theta));
  const qs = Float64Array.from(clean.map((l) => l.qv * 1e-3));
  const diag =
    clean.length > 2
      ? parcelAscent(zs, ps, ths, qs)
      : { cape: NaN, lclZ: NaN, elZ: NaN };

  return {
    levels: clean,
    psfc,
    time: col.times[i],
    elevation: col.elevation,
    skippedBelowGround: skipped,
    sourceCape: diag.cape,
    sourceLcl: diag.lclZ,
    sourceEl: diag.elZ,
  };
}

/** "Sat 22 Nov 18:00 UTC" from an Open-Meteo timestamp. */
export function formatTime(iso: string): string {
  const d = new Date(iso + "Z");
  return d.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }) + " UTC";
}

/** Index of the hour closest to now. */
export function nearestHour(times: string[]): number {
  const now = Date.now();
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < times.length; i++) {
    const d = Math.abs(new Date(times[i] + "Z").getTime() - now);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
