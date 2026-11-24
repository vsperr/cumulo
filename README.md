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

## On a phone

The layout switches itself: the 3D view goes full-bleed and the panels become
tabs along the bottom. The map takes taps, pinches and drags. A phone also gets
a lighter profile — a 32 × 32 × 32 domain, fewer ray-march samples and a capped
pixel ratio — because ray marching costs a shader run per pixel per sample and
a 3x display is the most expensive thing on screen. The `auto / PC / mobile`
selector in the header overrides the choice either way, which is also how the
phone layout gets tested from a desktop browser.

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

## Radar

There is a radar scope in the corner of the view — what a weather radar would
actually see of the storm you are running. For the exponential drop-size
distribution the Kessler scheme assumes, reflectivity follows the rain water
content directly:

    Z = 3.63e9 (rho q_r)^1.75   [mm^6/m^3],   dBZ = 10 log10 Z

the same diagnostic CM1 and WRF use. It puts 0.1 g/m³ of rain near 26 dBZ,
1 g/m³ near 43 and 5 g/m³ near 55 — the numbers you read off a real scope.

Two products: **composite reflectivity**, the column maximum in plan view with
range rings every 10 km, and a **vertical section** cut through the strongest
echo, like an RHI scan, with echo top at the 18 dBZ threshold. Reflectivity is
also available as a 3D field, in the same colour table.

Because radar sees rain and not cloud, a growing tower is invisible on the
scope until it starts making raindrops — watch the 3D view and the radar side
by side and the delay is obvious. That is not a bug in either one.

## Ice

The model carries three frozen species — cloud ice, snow and graupel — with
freezing, deposition, riming, collection and melting between them, and the
latent heat of fusion and sublimation in the energy budget. It can be switched
off, which is the honest way to see what it is doing.

Measured on the Weisman–Klemp supercell, 28 × 28 × 40, 45 minutes
(`npm run ice`):

| | warm rain | with ice |
| --- | --- | --- |
| anvil cover above 8 km, end of run | 9.7 % | **37.9 %** |
| cloud top, end of run | 11.6 km | 12.4 km |
| surface precipitation | 28 mm | 17 mm liquid + 17 mm frozen |
| peak graupel | — | 7.8 g/kg |
| peak reflectivity | — | 74 dBZ |
| cost | 1.00× | 1.41× |

The anvil result is the one to look at: four times the coverage, and it stays
there instead of evaporating, because ice falls slowly and sublimates slowly.
Graupel is what produces reflectivity above 70 dBZ — a severe core on radar is
hail, not rain — and melting graupel gives the bright band just below the
freezing level.

### Two bugs the ice work turned up

Checking the cold pool against the ice run exposed two long-standing errors in
the warm-rain scheme, both now fixed:

- **The evaporation ventilation factor was missing.** A falling drop sweeps out
  air and evaporates far faster than a still one; the Ogura–Takahashi rate
  carries a factor `1.6 + 124.9 (ρq)^0.2046`, worth 30 to 45×. Without it rain
  barely evaporated at all.
- **Rain fell 2.6× too fast.** Kessler's terminal velocity takes the rain water
  content in g/cm³; the code was feeding it kg/m³. Drops were doing 14 m/s
  instead of 5.5 and reached the ground before they could evaporate.

Together these took the surface cold pool from −0.1 K to −0.7 K.

### The cold pool is still too weak, and that is not fixed

A research model running this case produces a −4 to −6 K cold pool. This one
reaches about −0.7 K, and ice did not change that. The cause is not a coding
error: the energy budget closes exactly (2.74 K of cooling per 1.1 g/kg
evaporated, confirmed in a single-cell test), and neither halving the subgrid
mixing nor doubling the resolution moves the number.

What is missing is residence time and hail. Downdraft air arrives at the
surface from 3 km with a potential temperature 5 K above the environment, and
at the evaporation rates this scheme produces, the roughly 4 g/kg that would
have to evaporate during the descent simply does not. Real cold pools get a
large part of their cooling from melting and evaporating hail, which a scheme
with one graupel category and no size distribution cannot deliver. Treat gust
fronts and storm propagation here as qualitative.

## The CM1 look

The `style` control switches between the house look and **CM1 / VisIt**: the
way published CM1 figures are drawn. A bare matte-grey iso-surface of cloud
water with no material of its own, a daylight sky behind it, a reflectivity
slice lying on the ground in the continuous rainbow colour table, and the
mesocyclone picked out as an iso-surface of vertical vorticity.

Two honest caveats about that last one:

- **It marks the mesocyclone, not a tornado.** Peak vertical vorticity here is
  around 0.03 s⁻¹, which is mesocyclone scale. A tornado is 1 s⁻¹ and upward
  and needs grid spacing of order 100 m; at 600 m there is nothing to resolve.
  The published figures with a narrow vortex reaching the ground come from runs
  tens of times finer than anything a browser tab will do.
- **It is usually inside the cloud, and therefore hidden**, because occlusion
  is honest here: the nearer surface along each ray wins. The HUD prints the
  current maximum vorticity next to the iso level so you can pick a level that
  actually shows something.

The anvil is ice now, so it spreads and persists the way a real one does.

## Nothing is smoothed

Interpolation between grid cells is **off by default** in the house look, in
the 3D view and on the radar scope alike. (The CM1 style turns it back on: a
smooth iso-surface is exactly what a visualiser draws, and the smoothing there
is in the surface normals rather than a fog over the data.) Linear filtering invents values the solver never
computed: it looks soft and pretty, and it quietly implies a resolution the
model does not have. With it off you see the cells the solver actually
advanced, with hard edges — a 48-cell domain looks like a 48-cell domain.

The `smooth between cells` toggle turns it back on if you prefer the look, and
`contour bands` snaps the field to discrete levels the way a scientific contour
plot does. The radar scope is never smoothed: a radar product is a grid of
discrete gates in banded colours, and blurring one is a lie about the
resolution.

## Real soundings

There is a world map in the right-hand column. Click a point, pick a forecast
model, and the real atmosphere above that point becomes the model's initial
condition. The hour slider scrubs through a day of forecast without
refetching, so you can watch an air mass destabilise through the afternoon and
start a run from any moment.

Requests are kept deliberately small — seventeen pressure levels up to 70 hPa,
one day of hours — because a sounding request costs the free API about as much
as two ordinary calls. Picks are debounced, columns are cached for ten minutes,
and a rate-limit response backs off and retries rather than failing outright.

Ten models are offered through the [Open-Meteo](https://open-meteo.com) API —
no key, no account, nothing to install:

| | |
| --- | --- |
| **ICON** (DWD) | seamless, global, EU, and the 2 km D2 nest |
| **ECMWF IFS** | 25 km worldwide |
| **GFS** (NOAA) | global, with the 3 km HRRR nest over North America |
| **ARPEGE** (Météo-France), **UKMO**, **GEM** (Canada), **JMA** (Japan) | |

The map is drawn as plain polylines from Natural Earth data — no raster tiles,
nothing fetched at run time, in keeping with the rest of the project.

### What the grid costs you

A real sounding has far more vertical detail than a 400 m model grid can hold,
so cumulo reports both numbers: the CAPE of the source sounding at its own
resolution, and the CAPE this grid actually resolves. Over Cuiabá on a November
afternoon that is 3616 J/kg in the forecast against 2573 on a 40-level grid —
a coarse grid smooths the boundary layer and loses roughly a third of the
positive area. If the storm top would sit above the domain, it says so and
tells you to raise `nz`.

This is discretisation, not a bug, and every cloud model has it. Most of them
just do not tell you.

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
- **Real or idealised.** Start from a forecast sounding anywhere on Earth, or
  from the plain-language air mass above.
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

Two headless harnesses run the physics without a browser:

```bash
npm run sim -- 20 32 36   # 20 simulated minutes on a 32 x 32 x 36 grid
npm run ice -- 45 28 40   # the same storm with and without the ice phase
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
- **Cold pools are too weak**, by roughly a factor of five. See above: it is a
  limitation of a single-moment scheme with one graupel category, not a bug.
- **One frozen precipitation category.** Graupel stands in for everything from
  small hail to large; there is no separate hail class and no size
  distribution, so hail size cannot be read off the model.
- **Uniform vertical grid.** No stretching, so resolving the boundary layer and
  the tropopause at once is expensive.
- Momentum advection is second-order centred while scalars are third-order
  upwind; subgrid momentum mixing uses the scalar-point eddy viscosity.
- Single precision, no conservation fix-ups: read the numbers as behaviour, not
  as a forecast.

## Roadmap

- [ ] A hail category, or two-moment microphysics, for a realistic cold pool
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

## Data and credits

Forecast soundings come from [Open-Meteo](https://open-meteo.com), licensed
CC-BY-4.0, which in turn redistributes output from DWD, ECMWF, NOAA,
Météo-France, the UK Met Office, Environment Canada and JMA. Nothing is
requested until you click the map.

Coastlines and borders are Natural Earth (public domain) via
[world-atlas](https://github.com/topojson/world-atlas).

## License

MIT. See [LICENSE](LICENSE).
