# cumulo

A cloud-resolving convection model that runs in a browser tab.

cumulo integrates the compressible, non-hydrostatic equations of motion with
warm-rain microphysics — the same class of model as [CM1][cm1] — and draws the
result as an untextured 3D volume. You set the sounding by hand, press Run, and
watch what the atmosphere does with it.

**[Open the model → vsperr.github.io/cumulo](https://vsperr.github.io/cumulo/)**

## Why

Cloud models are how we know what we know about thunderstorms, and they are all
but unreachable: a Fortran build, a batch queue, NetCDF output and a separate
plotting stack before you see a single cloud. The physics is not the hard part.
The friction is.

cumulo removes the friction. The solver is a thousand lines of TypeScript, it
runs in a web worker faster than real time, and the entire state of an
experiment — sounding, numerics, camera-independent view settings — lives in one
URL you can paste to someone.

Speed depends on the machine and the grid: on an idle laptop the default
48 × 48 × 40 domain runs at roughly 30× real time, and about 7× when something
else is using the CPU. Smaller grids are proportionally quicker.

## Two ways in

The model opens in **simple mode**, where an air mass is described the way a
forecaster would describe it — four numbers:

| You set | What it controls |
| --- | --- |
| Surface temperature | How warm it is at the ground |
| Dewpoint | How humid. The gap to the temperature sets the cloud base, about 125 m per degree |
| CAPE | The fuel. 1000–2500 J/kg is an ordinary thunderstorm; over 3500 is extreme |
| Tropopause height | The lid the storm cannot grow past |

CAPE is an input, not an output. You ask for 2500 J/kg and the model solves for
the lapse rate aloft that delivers exactly that, by bisection on the upper
tropospheric temperature, keeping your temperature and dewpoint — and therefore
your cloud base — fixed. The readout tells you in words what you have built:
*"3996 J/kg — strong storms", "24 m/s shear — supercell shear"*.

**All parameters** switches to the full panel: roughly sixty controls covering
the analytic profile, every numerical setting and each microphysics rate. The
simple numbers and the expert ones are the same configuration object, so you
can set CAPE by hand and then go look at what it did to the profile.

## What it does

- **Full control of the sounding.** In expert mode: the analytic Weisman–Klemp
  profile with every exponent and endpoint exposed, or paste a CM1/WRF
  `input_sounding` table. Hodograph presets from uniform flow to a half-circle;
  Galilean frame shift to keep the storm in the domain.
- **Every numerical knob is a control.** Grid size and spacing, the large time
  step, acoustic substeps, divergence damping, Rayleigh sponge, lateral
  boundary condition, Smagorinsky constant, each Kessler rate coefficient,
  Coriolis, surface drag.
- **Live convective indices.** In expert mode: CAPE, CIN, LCL, LFC, EL, lifted index,
  precipitable water, 0–1 and 0–6 km shear, 0–3 km storm-relative helicity,
  drawn on a skew-T and a hodograph that update as you type.
- **A textureless 3D view.** No image textures anywhere in the pipeline. The
  only sampler is the model's own water field, ray-marched with analytic
  single-scattering, and the grid lines in iso-surface mode are the model's
  actual cells. Three shading modes: volumetric, iso-surface, iso-surface with
  cells.
- **Diagnostics while it runs.** Maximum and minimum vertical velocity, cloud
  and rain mixing ratios, cloud top, accumulated rainfall, advective and
  acoustic CFL, and the cost per step.

## Presets

| Preset | What it shows |
| --- | --- |
| Supercell (Weisman–Klemp) | 2000 J/kg CAPE, 25 m/s straight shear: the textbook splitting storm |
| Supercell, curved hodograph | Same thermodynamics, half-circle hodograph: one dominant right mover |
| Pulse storm | Same CAPE, no shear: rises, rains, kills its own updraft |
| Squall line | Shallow strong shear; the cold pool takes over |
| Shallow cumulus | Weak CAPE, dry aloft: small non-precipitating clouds |
| Tropical oceanic | Warm, deep, nearly shear-free towers |
| High-based and dry | Hot dry boundary layer, strong evaporative downdrafts |

## Running it locally

```bash
npm install
npm run dev
```

The solver also runs headless, which is the fastest way to check a change to the
physics:

```bash
npm run sim -- 20 32 36   # 20 simulated minutes on a 32 x 32 x 36 grid
```

```
=== base state ===
surface     p=97761 Pa  T=25.2 C  qv=14.00 g/kg
CAPE        2038 J/kg   CIN 35 J/kg   LCL 1400 m   LFC 1400 m   EL 11800 m

=== integration ===
  t[min]   maxW   minW   maxQc  maxQr  maxTh  top[km]  rain[mm]  CFL
     8.1   10.64  -3.06   2.963  0.208   4.84     4.80     0.000  0.24
    13.5   34.63 -10.58   3.998  5.029   9.54     8.40     2.343  0.57
    20.0   40.10 -25.78   2.549  4.546   5.65    11.60    31.569  0.61
```

## How it works

The short version: three-stage Runge–Kutta for the slow terms, forward–backward
acoustic substeps inside each stage for the pressure–velocity coupling,
third-order upwind advection for scalars, Smagorinsky subgrid mixing, Kessler
warm rain, all on a staggered C-grid.

The long version, with the equations as implemented, is in
[`docs/physics.md`](docs/physics.md).

```
src/core/      thermodynamics, sounding, solver, microphysics  (no DOM, no WebGL)
src/worker/    the solver on its own thread
src/render/    three.js scene and the ray-marching shader
src/ui/        schema-driven control panel, skew-T and hodograph
```

`src/core` has no browser dependencies at all, which is why the same code runs
under Node for the headless test.

## Known limits

- **CAPE is reached by tuning one knob.** The bisection moves the upper
  tropospheric temperature only. Two soundings with the same CAPE but different
  shapes of the positive area behave differently, and simple mode cannot
  express that; expert mode can.
- **No ice.** Anvils are liquid, there is no melting term, and cold pools are
  biased because of it. This is the biggest physical gap.
- **Uniform vertical grid.** No stretching, so resolving the boundary layer and
  the tropopause at once is expensive.
- Momentum advection is second-order centred while scalars are third-order
  upwind; subgrid momentum mixing uses the scalar-point eddy viscosity.
- Single precision, no conservation fix-ups: read the numbers as behaviour, not
  as a forecast.

## Roadmap

- [ ] Ice microphysics (a Lin-type or simple two-moment scheme)
- [ ] Stretched vertical grid
- [ ] GPU solver via WebGL2 transform feedback or WebGPU compute
- [ ] Cross-section and vertical-profile panels alongside the 3D view
- [ ] Trajectory and streamline rendering, still without textures
- [ ] Export a run as NetCDF-like JSON, and as a frame sequence

Contributions are welcome — the physics modules are deliberately small and
readable, and `npm run sim` makes it easy to see what a change did.

## Deploying your own copy

Push to `main` with GitHub Pages set to "GitHub Actions" as its source; the
workflow in `.github/workflows/deploy.yml` builds and publishes `dist/`. For a
custom domain, add a `public/CNAME` file containing the domain and set it in the
repository's Pages settings.

## License

MIT. See [LICENSE](LICENSE).
