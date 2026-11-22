import { defaultConfig, type Config } from "../core/config";

export interface Preset {
  id: string;
  name: string;
  note: string;
  apply: (c: Config) => void;
}

/**
 * Classic idealised set-ups. Each one only nudges the default configuration, so
 * every value stays visible and editable in the panel afterwards.
 */
export const PRESETS: Preset[] = [
  {
    id: "wk-supercell",
    name: "Supercell (Weisman-Klemp)",
    note: "2000 J/kg CAPE, 25 m/s of unidirectional shear over 6 km. The textbook splitting storm.",
    apply: (c) => {
      c.sounding.thetaSfc = 300;
      c.sounding.qvMax = 14;
      c.sounding.windMode = "linear";
      c.sounding.shearMag = 25;
      c.sounding.shearDepth = 6000;
      c.sounding.uSfc = -12;
    },
  },
  {
    id: "wk-curved",
    name: "Supercell, curved hodograph",
    note: "Same thermodynamics, half-circle hodograph. Favours one dominant right-moving storm.",
    apply: (c) => {
      c.sounding.windMode = "halfCircle";
      c.sounding.shearMag = 30;
      c.sounding.shearDepth = 6000;
      c.sounding.uSfc = 0;
      c.sounding.vSfc = -8;
    },
  },
  {
    id: "pulse",
    name: "Pulse storm (no shear)",
    note: "Same CAPE, no shear at all. Rises, rains, kills its own updraft within half an hour.",
    apply: (c) => {
      c.sounding.windMode = "none";
      c.sounding.uSfc = 0;
      c.sounding.vSfc = 0;
    },
  },
  {
    id: "squall",
    name: "Squall line",
    note: "Strong low-level shear in a shallow layer; a line-type cold pool takes over.",
    apply: (c) => {
      c.sounding.windMode = "linear";
      c.sounding.shearMag = 20;
      c.sounding.shearDepth = 2500;
      c.sounding.uSfc = -10;
      c.bubble.radiusH = 10000;
      c.bubble.radiusV = 1400;
      c.bubble.amplitude = 3;
    },
  },
  {
    id: "cumulus",
    name: "Shallow cumulus",
    note: "Weak CAPE, dry mid-levels, low tropopause. Small non-precipitating clouds.",
    apply: (c) => {
      c.sounding.thetaSfc = 297;
      c.sounding.thetaTropopause = 325;
      c.sounding.zTropopause = 8000;
      c.sounding.qvMax = 10;
      c.sounding.rhSfc = 0.9;
      c.sounding.rhTropopause = 0.15;
      c.sounding.mixedLayerDepth = 600;
      c.bubble.amplitude = 1.5;
      c.bubble.radiusV = 800;
      c.bubble.centerZ = 600;
      c.grid.dz = 250;
      c.grid.nz = 36;
      c.grid.dx = 300;
      c.grid.dy = 300;
    },
  },
  {
    id: "tropical",
    name: "Tropical oceanic",
    note: "Warm, deep, moist and nearly shear-free: tall towers with heavy rain.",
    apply: (c) => {
      c.sounding.thetaSfc = 299;
      c.sounding.qvMax = 18;
      c.sounding.rhSfc = 1;
      c.sounding.rhTropopause = 0.4;
      c.sounding.zTropopause = 15000;
      c.sounding.thetaTropopause = 350;
      c.sounding.windMode = "linear";
      c.sounding.shearMag = 6;
      c.grid.nz = 48;
      c.grid.dz = 400;
    },
  },
  {
    id: "dry",
    name: "High-based, dry low levels",
    note: "Hot and dry near the ground: high cloud bases, strong evaporative downdrafts.",
    apply: (c) => {
      c.sounding.thetaSfc = 308;
      c.sounding.qvMax = 8;
      c.sounding.rhSfc = 0.55;
      c.sounding.rhTropopause = 0.2;
      c.sounding.mixedLayerDepth = 1200;
      c.bubble.amplitude = 4;
      c.bubble.centerZ = 2500;
      c.physics.rainEvaporation = 1.4;
    },
  },
];

export function configFromPreset(id: string): Config {
  const c = defaultConfig();
  const p = PRESETS.find((x) => x.id === id);
  p?.apply(c);
  return c;
}
