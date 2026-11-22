/**
 * Every knob of the model lives here. Nothing is hard-coded elsewhere, so the
 * UI can expose the whole configuration and a run is fully described by this
 * object (it serialises to JSON and back).
 */

export type WindMode = "none" | "linear" | "quarterCircle" | "halfCircle" | "table";
export type SoundingMode = "analytic" | "table";
export type BoundaryMode = "periodic" | "open";

export interface SoundingLevel {
  z: number; // m AGL
  theta: number; // K
  qv: number; // g/kg
  u: number; // m/s
  v: number; // m/s
}

export interface SoundingConfig {
  mode: SoundingMode;

  /**
   * --- plain-language inputs ---
   * When `easy` is on, these three numbers drive the whole thermodynamic
   * profile: the surface temperature and dewpoint fix the boundary layer and
   * therefore the cloud base, and the lapse rate aloft is then solved for so
   * the sounding delivers exactly `targetCape`. The analytic parameters below
   * are derived from them and stay visible in expert mode.
   */
  easy: boolean;
  surfaceT: number; // deg C
  surfaceTd: number; // deg C
  targetCape: number; // J/kg

  /** Surface values, used by both modes. */
  psfc: number; // hPa
  thetaSfc: number; // K

  /** --- analytic (Weisman & Klemp 1982) --- */
  thetaTropopause: number; // K
  zTropopause: number; // m
  tempTropopause: number; // K
  thetaExponent: number; // shape exponent of the tropospheric theta profile
  qvMax: number; // g/kg, cap on the boundary-layer mixing ratio
  rhSfc: number; // 0..1
  rhTropopause: number; // 0..1
  rhExponent: number;
  /** Depth of a well-mixed, constant-theta surface layer [m]. */
  mixedLayerDepth: number;

  /** --- wind profile --- */
  windMode: WindMode;
  shearMag: number; // m/s of wind change across the shear layer
  shearDepth: number; // m
  uSfc: number; // m/s
  vSfc: number; // m/s
  /** Wind above the shear layer is held constant. */
  galileanU: number; // m/s subtracted from the whole profile (storm-following frame)
  galileanV: number;

  /** --- table mode --- */
  levels: SoundingLevel[];
}

export interface BubbleConfig {
  enabled: boolean;
  amplitude: number; // K
  radiusH: number; // m
  radiusV: number; // m
  centerX: number; // fraction of domain, 0..1
  centerY: number;
  centerZ: number; // m AGL
  moisten: number; // added RH inside the bubble, 0..1
  /** Amplitude of random theta noise in the lowest levels [K]. */
  noise: number;
}

export interface GridConfig {
  nx: number;
  ny: number;
  nz: number;
  dx: number; // m
  dy: number; // m
  dz: number; // m
}

export interface NumericsConfig {
  dt: number; // s, large (advective) step
  acousticSteps: number; // target substeps per large step
  /** Raise the substep count automatically when the acoustic CFL would exceed 1. */
  autoAcoustic: boolean;
  divergenceDamping: number; // 0..0.2
  advectionOrder: 3 | 5;
  rayleighDepth: number; // m, sponge layer depth below the model top
  rayleighRate: number; // 1/s at the top of the domain
  boundary: BoundaryMode;
  /** Steps of the model per animation frame. */
  stepsPerFrame: number;
}

export interface PhysicsConfig {
  microphysics: boolean;
  autoconversionThreshold: number; // kg/kg, qc above which rain forms
  autoconversionRate: number; // 1/s
  accretionRate: number; // 1/s
  rainEvaporation: number; // scaling of the evaporation rate
  rainFallSpeed: number; // scaling of the terminal fall speed
  smagorinsky: number; // Smagorinsky constant, 0 disables
  backgroundDiffusion: number; // m^2/s
  surfaceDrag: number; // bulk drag coefficient, 0 = free slip
  coriolis: boolean;
  latitude: number; // deg
}

export interface RenderConfig {
  mode: "volume" | "surface" | "wire";
  field: "cloud" | "rain" | "total" | "updraft";
  threshold: number; // g/kg, iso level for surface/wire modes
  density: number; // extinction scaling for volume mode
  steps: number; // raymarch samples
  sunAzimuth: number; // deg
  sunElevation: number; // deg
  showBox: boolean;
  showGround: boolean;
  showUpdraft: boolean;
  exaggerateZ: number; // vertical stretch of the rendered box
}

export interface UiConfig {
  /** Expert mode shows every parameter; basic mode shows the short list. */
  expert: boolean;
}

export interface Config {
  ui: UiConfig;
  grid: GridConfig;
  numerics: NumericsConfig;
  physics: PhysicsConfig;
  sounding: SoundingConfig;
  bubble: BubbleConfig;
  render: RenderConfig;
}

export function defaultConfig(): Config {
  return {
    ui: { expert: false },
    grid: { nx: 48, ny: 48, nz: 40, dx: 600, dy: 600, dz: 400 },
    numerics: {
      dt: 3,
      acousticSteps: 6,
      autoAcoustic: true,
      divergenceDamping: 0.1,
      advectionOrder: 3,
      rayleighDepth: 4000,
      rayleighRate: 0.003,
      boundary: "periodic",
      stepsPerFrame: 1,
    },
    physics: {
      microphysics: true,
      autoconversionThreshold: 1.0e-3,
      autoconversionRate: 1.0e-3,
      accretionRate: 2.2,
      rainEvaporation: 1,
      rainFallSpeed: 1,
      smagorinsky: 0.18,
      backgroundDiffusion: 5,
      surfaceDrag: 0,
      coriolis: false,
      latitude: 40,
    },
    sounding: {
      mode: "analytic",
      easy: true,
      surfaceT: 25,
      surfaceTd: 19,
      targetCape: 2000,
      psfc: 1000,
      thetaSfc: 300,
      thetaTropopause: 343,
      zTropopause: 12000,
      tempTropopause: 213,
      thetaExponent: 1.25,
      qvMax: 14,
      rhSfc: 1,
      rhTropopause: 0.25,
      rhExponent: 1.25,
      mixedLayerDepth: 0,
      windMode: "linear",
      shearMag: 25,
      shearDepth: 6000,
      uSfc: -12,
      vSfc: 0,
      galileanU: 0,
      galileanV: 0,
      levels: [],
    },
    bubble: {
      enabled: true,
      amplitude: 2.5,
      radiusH: 5000,
      radiusV: 1500,
      centerX: 0.5,
      centerY: 0.5,
      centerZ: 1500,
      moisten: 0,
      noise: 0.1,
    },
    render: {
      mode: "volume",
      field: "total",
      threshold: 0.05,
      density: 1,
      steps: 160,
      sunAzimuth: 135,
      sunElevation: 35,
      showBox: true,
      showGround: true,
      showUpdraft: true,
      exaggerateZ: 1,
    },
  };
}

export function cloneConfig(c: Config): Config {
  return JSON.parse(JSON.stringify(c)) as Config;
}
