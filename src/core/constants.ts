/** Physical constants, CM1-compatible values. */
export const Rd = 287.04; // dry air gas constant [J/kg/K]
export const Rv = 461.5; // water vapour gas constant [J/kg/K]
export const cp = 1005.7; // specific heat, dry air, const. pressure [J/kg/K]
export const cv = cp - Rd; // specific heat, const. volume [J/kg/K]
export const g = 9.81; // gravity [m/s^2]
export const p00 = 1.0e5; // reference pressure [Pa]
export const Lv = 2.501e6; // latent heat of vaporisation [J/kg]
export const eps = Rd / Rv; // 0.6220
export const reps = Rv / Rd; // 1.6077
export const rovcp = Rd / cp;
export const cpovcv = cp / cv;
export const omegaEarth = 7.292e-5; // Earth rotation rate [1/s]
