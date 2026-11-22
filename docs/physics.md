# The model

cumulo integrates the fully compressible, non-hydrostatic equations of motion on
a staggered Arakawa C-grid, in the same family as [CM1][cm1], [WRF][wrf] and the
Klemp–Wilhelmson class of cloud models. Everything below is implemented in
`src/core/`, in about a thousand lines of plain TypeScript.

[cm1]: https://www2.mmm.ucar.edu/people/bryan/cm1/
[wrf]: https://www2.mmm.ucar.edu/wrf/users/

## Base state

The model is linearised about a dry hydrostatic base state that depends on
height only. Given a potential temperature profile `θ̄(z)` and a moisture
profile `q̄v(z)`, the Exner pressure follows from

    dπ̄/dz = -g / (c_p θ̄_v)

integrated upward from the surface pressure. Because the saturation mixing ratio
depends on pressure and the pressure depends on the virtual temperature, the
column is iterated to convergence (`buildBaseState` in `src/core/sounding.ts`).

The analytic profile is the one of Weisman & Klemp (1982):

    θ(z) = θ_0 + (θ_tr - θ_0) (z/z_tr)^1.25        z ≤ z_tr
    θ(z) = θ_tr exp[ g (z - z_tr) / (c_p T_tr) ]    z > z_tr
    RH(z) = RH_sfc + (RH_tr - RH_sfc) (z/z_tr)^1.25

with the mixing ratio capped at `qv_max`. Every exponent, endpoint and cap is a
configuration field, and the whole profile can be replaced by a level table in
the CM1/WRF `input_sounding` format.

## Prognostic equations

With `u, v, w` the velocity components, `π'` the Exner perturbation and `θ'` the
potential temperature perturbation:

    ∂u/∂t = -ADV(u) - c_p θ̄_v ∂π'/∂x + D_u
    ∂v/∂t = -ADV(v) - c_p θ̄_v ∂π'/∂y + D_v
    ∂w/∂t = -ADV(w) - c_p θ̄_v ∂π'/∂z + g B + D_w
    ∂π'/∂t = -(R_d π̄)/(c_v ρ̄ θ̄_v) ∇·(ρ̄ θ̄_v V)
    ∂θ'/∂t = -ADV(θ') - w ∂θ̄/∂z + D_θ + (L_v/c_p π̄) C
    ∂q_v/∂t = -ADV(q_v') - w ∂q̄_v/∂z + D_q - C + E
    ∂q_c/∂t = -ADV(q_c) + D_q + C - A - K
    ∂q_r/∂t = -ADV(q_r) + D_q + A + K - E + (1/ρ̄) ∂(ρ̄ q_r V_t)/∂z

The buoyancy includes the virtual effect and the weight of the condensate:

    B = θ'/θ̄ + 0.608 (q_v - q̄_v) - q_c - q_r

The pressure equation is the acoustically complete form, so the model carries
sound waves; `c² = (c_p/c_v) R_d T` comes out of it exactly.

## Time integration

Slow terms (advection, buoyancy, mixing, Coriolis) are advanced with the
three-stage Runge–Kutta scheme of Wicker & Skamarock (2002), using stage lengths
`Δt/3`, `Δt/2`, `Δt`. Inside every stage the velocity–pressure coupling is
integrated with forward–backward acoustic substeps, so the sound waves are
stable without an implicit solve.

The acoustic substep must satisfy

    Δτ < 1 / ( c √(1/Δx² + 1/Δy² + 1/Δz²) )

and the substep count is scaled with the stage length so that `Δτ` is the same
in all three stages — getting this wrong is the single most common way to blow
the model up, and `autoAcoustic` guards against it. Divergence damping (Klemp &
Wilhelmson 1978) suppresses the remaining acoustic noise.

Horizontal advection of scalars uses the third-order upwind-biased flux of
Wicker & Skamarock; momentum uses second-order centred fluxes.

## Subgrid mixing

A Smagorinsky closure sets the eddy viscosity from the resolved deformation,

    K_m = (C_s Δ)² |S|,   Δ = (Δx Δy Δz)^(1/3)

with a turbulent Prandtl number of 1/3 for scalars and a configurable background
value. `K_m` is capped at the diffusive stability limit for the current step.

## Microphysics

Kessler (1969) warm rain, in `src/core/microphysics.ts`:

- **Condensation / evaporation** by iterative saturation adjustment against the
  Bolton (1980) saturation vapour pressure.
- **Autoconversion** of cloud to rain above a threshold mixing ratio.
- **Accretion** of cloud droplets by rain, `∝ q_c q_r^0.875`.
- **Rain evaporation** in subsaturated air, with the Ogura–Takahashi ventilation
  factor.
- **Sedimentation** with `V_t = 36.34 (ρ q_r)^0.1364 √(ρ_0/ρ)`, integrated
  upstream with CFL substepping. The flux out of the lowest level accumulates as
  surface rainfall.

There is no ice. Deep storms in the model therefore glaciate nowhere, anvils are
liquid, and cold-pool strength is biased by the missing melting term. This is
the main physical gap, and it is the first item on the roadmap.

## Boundaries

Lateral boundaries are periodic (the default) or zero-gradient. The top and
bottom are rigid and free-slip, with an optional bulk drag at the surface and a
Rayleigh sponge below the model top to absorb gravity waves.

## What this model is not

It is a teaching and exploration tool, not a research model. It has no ice
microphysics, no radiation, no surface energy balance, no terrain, no nesting,
no stretched vertical grid and no data assimilation. Single precision and a
coarse grid mean numbers should be read as "this is the kind of storm you get",
not as a forecast. For research, use CM1.

## References

- Klemp, J. B. and R. B. Wilhelmson, 1978: The simulation of three-dimensional
  convective storm dynamics. *J. Atmos. Sci.*, **35**, 1070–1096.
- Weisman, M. L. and J. B. Klemp, 1982: The dependence of numerically simulated
  convective storms on vertical wind shear and buoyancy. *Mon. Wea. Rev.*,
  **110**, 504–520.
- Wicker, L. J. and W. C. Skamarock, 2002: Time-splitting methods for elastic
  models using forward time schemes. *Mon. Wea. Rev.*, **130**, 2088–2097.
- Kessler, E., 1969: On the distribution and continuity of water substance in
  atmospheric circulations. *Meteor. Monogr.*, **10**, 1–84.
- Bryan, G. H. and J. M. Fritsch, 2002: A benchmark simulation for moist
  nonhydrostatic numerical models. *Mon. Wea. Rev.*, **130**, 2917–2928.
