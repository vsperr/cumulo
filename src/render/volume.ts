import * as THREE from "three";

/**
 * Raymarched view of the model's water field. Everything is analytic: there is
 * not a single image texture in the pipeline. The only sampler is the model's
 * own data volume (cloud water, rain water and vertical velocity), and all
 * shading comes from closed-form scattering and procedural grid lines.
 */

const vertexShader = /* glsl */ `
out vec3 vLocal;
void main() {
  vLocal = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = /* glsl */ `
precision highp float;
precision highp sampler3D;

in vec3 vLocal;
out vec4 outColor;

// three.js declares these only in the vertex stage; the fragment stage needs
// its own declarations, and the renderer fills them in by name.
uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;

uniform sampler3D uField;
uniform sampler3D uVort;
uniform vec3 uCamLocal;
uniform vec3 uSun;
uniform float uDensity;
uniform float uThreshold;
uniform int uSteps;
uniform int uMode;        // 0 volume, 1 surface, 2 wire
uniform int uFieldSel;    // 0 cloud, 1 rain, 2 total, 3 updraft
uniform float uShowUpdraft;
uniform vec3 uGridCells;
uniform float uWMax;
/** Width of a contour band in g/kg; 0 leaves the field continuous. */
uniform float uContourStep;
uniform float uCloudGrey;   // shade the cloud as bare matte grey
uniform float uPalette;     // 0 = banded operational, 1 = continuous CM1 rainbow
uniform float uShowVortex;
uniform float uVortLevel;

const vec3 CLOUD_BRIGHT = vec3(1.00, 0.99, 0.97);
const vec3 CLOUD_SHADE  = vec3(0.34, 0.39, 0.50);
const vec3 RAIN_TINT    = vec3(0.42, 0.52, 0.66);
const vec3 SKY_AMBIENT  = vec3(0.45, 0.58, 0.78);
const vec3 UP_TINT      = vec3(1.00, 0.45, 0.18);
const vec3 DOWN_TINT    = vec3(0.25, 0.55, 1.00);

// Model volume is indexed (east, north, up); the box is (east, up, north).
vec3 toTex(vec3 p) {
  vec3 uv = p + 0.5;
  return vec3(uv.x, uv.z, uv.y);
}

vec4 sampleField(vec3 p) {
  return texture(uField, toTex(p));
}

// The standard weather-radar colour table, as steps rather than a gradient.
vec3 radarColor(float dbz) {
  if (dbz < 10.0) return vec3(0.016, 0.914, 0.906);
  if (dbz < 15.0) return vec3(0.004, 0.624, 0.957);
  if (dbz < 20.0) return vec3(0.012, 0.000, 0.957);
  if (dbz < 25.0) return vec3(0.008, 0.992, 0.008);
  if (dbz < 30.0) return vec3(0.004, 0.773, 0.004);
  if (dbz < 35.0) return vec3(0.000, 0.557, 0.000);
  if (dbz < 40.0) return vec3(0.992, 0.973, 0.008);
  if (dbz < 45.0) return vec3(0.898, 0.737, 0.000);
  if (dbz < 50.0) return vec3(0.992, 0.584, 0.000);
  if (dbz < 55.0) return vec3(0.992, 0.000, 0.000);
  if (dbz < 60.0) return vec3(0.831, 0.000, 0.000);
  if (dbz < 65.0) return vec3(0.737, 0.000, 0.000);
  if (dbz < 70.0) return vec3(0.973, 0.000, 0.992);
  if (dbz < 75.0) return vec3(0.596, 0.329, 0.776);
  return vec3(1.0);
}

// The continuous rainbow CM1 reflectivity is conventionally plotted with.
vec3 cm1Color(float d) {
  if (d <= -10.0) return vec3(0.000, 0.000, 0.549);
  if (d <   0.0) return mix(vec3(0.000,0.000,0.549), vec3(0.000,0.451,1.000), (d+10.0)*0.1);
  if (d <  10.0) return mix(vec3(0.000,0.451,1.000), vec3(0.000,0.902,0.949), d*0.1);
  if (d <  20.0) return mix(vec3(0.000,0.902,0.949), vec3(0.102,0.851,0.200), (d-10.0)*0.1);
  if (d <  30.0) return mix(vec3(0.102,0.851,0.200), vec3(0.549,0.949,0.102), (d-20.0)*0.1);
  if (d <  40.0) return mix(vec3(0.549,0.949,0.102), vec3(1.000,0.949,0.000), (d-30.0)*0.1);
  if (d <  50.0) return mix(vec3(1.000,0.949,0.000), vec3(1.000,0.451,0.000), (d-40.0)*0.1);
  if (d <  60.0) return mix(vec3(1.000,0.451,0.000), vec3(0.949,0.000,0.000), (d-50.0)*0.1);
  if (d <  70.0) return mix(vec3(0.949,0.000,0.000), vec3(0.851,0.000,0.749), (d-60.0)*0.1);
  return mix(vec3(0.851,0.000,0.749), vec3(1.000,0.749,0.949), clamp((d-70.0)*0.1,0.0,1.0));
}

vec3 dbzColor(float d) {
  return uPalette > 0.5 ? cm1Color(d) : radarColor(d);
}

float vortAt(vec3 p) {
  return texture(uVort, toTex(p)).r;
}

// Value of the selected field at a sample, in g/kg or an equivalent magnitude.
float fieldOf(vec4 s) {
  float q;
  if (uFieldSel == 0) q = s.r;
  else if (uFieldSel == 1) q = s.g;
  else if (uFieldSel == 3) q = abs(s.b);
  else if (uFieldSel == 4) q = max(s.a - 5.0, 0.0) * 0.12; // dBZ, rescaled
  else q = s.r + s.g;
  // Snap to contour bands: the model's own levels, not an invented gradient.
  if (uContourStep > 0.0) q = floor(q / uContourStep) * uContourStep;
  return q;
}

float waterAt(vec3 p) {
  return fieldOf(sampleField(p));
}

// Cheap per-pixel hash, used to offset where each ray starts sampling.
// Without it the fixed sample spacing paints visible rings and dots wherever
// the cloud is small compared with the box; with it the error becomes noise,
// which the eye forgives.
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Slab intersection with the unit box centred on the origin.
bool boxHit(vec3 ro, vec3 rd, out float t0, out float t1) {
  vec3 inv = 1.0 / rd;
  vec3 a = (vec3(-0.5) - ro) * inv;
  vec3 b = (vec3( 0.5) - ro) * inv;
  vec3 lo = min(a, b);
  vec3 hi = max(a, b);
  t0 = max(max(lo.x, lo.y), lo.z);
  t1 = min(min(hi.x, hi.y), hi.z);
  return t1 > max(t0, 0.0);
}

/**
 * Depth of a point along the ray, in window coordinates.
 *
 * Without this the fragment keeps the depth of the box's back face, which is
 * behind everything inside the box — so the ground slice and the cloud sorted
 * against each other by the wrong value and whichever drew second won.
 */
float depthAt(vec3 pLocal) {
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(pLocal, 1.0);
  return (clip.z / clip.w) * 0.5 + 0.5;
}

vec3 gradient(vec3 p, float h) {
  return vec3(
    waterAt(p + vec3(h, 0.0, 0.0)) - waterAt(p - vec3(h, 0.0, 0.0)),
    waterAt(p + vec3(0.0, h, 0.0)) - waterAt(p - vec3(0.0, h, 0.0)),
    waterAt(p + vec3(0.0, 0.0, h)) - waterAt(p - vec3(0.0, 0.0, h))
  );
}

// Optical depth from a point toward the sun: this is what gives the cloud its
// self-shadowing, and it is the only lighting model here.
float sunDepth(vec3 p, float step) {
  float tau = 0.0;
  vec3 q = p;
  for (int i = 0; i < 6; i++) {
    q += uSun * step;
    if (any(greaterThan(abs(q), vec3(0.5)))) break;
    tau += waterAt(q) * step;
  }
  return tau;
}

void main() {
  vec3 ro = uCamLocal;
  vec3 rd = normalize(vLocal - uCamLocal);
  float t0, t1;
  if (!boxHit(ro, rd, t0, t1)) discard;
  t0 = max(t0, 0.0);

  float span = t1 - t0;
  float steps = float(uSteps);
  float dt = span / steps;

  // Jitter breaks up the rings a fixed sample spacing paints in the volume
  // render. An iso-surface wants the opposite: with a thin, nearly uniform
  // layer sitting right on the threshold, neighbouring pixels sampling at
  // different offsets disagree about whether they crossed it at all, and the
  // surface dissolves into speckle. Surfaces sample deterministically.
  float jitter = (uMode == 0) ? hash12(gl_FragCoord.xy) : 0.5;

  if (uMode == 0) {
    // --- volumetric absorption + single scattering ---
    vec3 acc = vec3(0.0);
    float trans = 1.0;
    float sunStep = 1.6 / 6.0;
    float firstT = -1.0;
    for (int i = 0; i < 512; i++) {
      if (i >= uSteps || trans < 0.004) break;
      float t = t0 + (float(i) + jitter) * dt;
      vec3 p = ro + rd * t;
      if (uShowVortex > 0.5) {
        float z = vortAt(p);
        if (abs(z) >= uVortLevel) {
          vec3 vc = z > 0.0 ? vec3(0.76, 0.52, 0.86) : vec3(0.35, 0.78, 0.82);
          acc += vc * trans;
          trans = 0.0;
          if (firstT < 0.0) firstT = t;
          break;
        }
      }
      vec4 s = sampleField(p);
      float q = fieldOf(s);
      if (q < 1.0e-3) continue;
      if (firstT < 0.0) firstT = t;

      float sigma = q * uDensity * 3.0;
      float a = 1.0 - exp(-sigma * dt * 60.0);

      float tau = sunDepth(p, sunStep) * uDensity * 3.0 * 12.0;
      float light = exp(-tau);
      float rainFrac = (s.r + s.g > 1.0e-6) ? s.g / (s.r + s.g) : 0.0;
      vec3 albedo = (uFieldSel == 4)
        ? dbzColor(s.a)
        : mix(CLOUD_BRIGHT, RAIN_TINT, rainFrac);
      vec3 col = (uFieldSel == 4)
        ? albedo * (0.55 + 0.45 * light)
        : albedo * (SKY_AMBIENT * 0.42 + vec3(1.0, 0.96, 0.88) * light);
      if (uFieldSel != 4) col = mix(CLOUD_SHADE * albedo, col, 0.18 + 0.82 * light);

      if (uShowUpdraft > 0.5) {
        float wn = clamp(s.b / uWMax, -1.0, 1.0);
        vec3 tint = wn > 0.0 ? UP_TINT : DOWN_TINT;
        col += tint * abs(wn) * 0.55 * light;
      }

      acc += col * a * trans;
      trans *= 1.0 - a;
    }
    float alpha = 1.0 - trans;
    if (alpha < 0.004) discard;
    gl_FragDepth = depthAt(ro + rd * max(firstT, t0));
    outColor = vec4(acc / max(alpha, 1.0e-4), alpha);
    return;
  }

  // --- iso-surface: first crossing of the threshold, flat analytic shading ---
  float prev = 0.0;
  for (int i = 0; i < 512; i++) {
    if (i >= uSteps) break;
    float t = t0 + (float(i) + jitter) * dt;
    vec3 p = ro + rd * t;
    if (uShowVortex > 0.5) {
      float z = vortAt(p);
      if (abs(z) >= uVortLevel) {
        vec3 gz = vec3(
          abs(vortAt(p + vec3(0.004,0,0))) - abs(vortAt(p - vec3(0.004,0,0))),
          abs(vortAt(p + vec3(0,0.004,0))) - abs(vortAt(p - vec3(0,0.004,0))),
          abs(vortAt(p + vec3(0,0,0.004))) - abs(vortAt(p - vec3(0,0,0.004)))
        );
        float gzlen = length(gz);
        vec3 nv = gzlen > 1.0e-6 ? -gz / gzlen : -rd;
        float dv = max(dot(nv, uSun), 0.0);
        vec3 base = z > 0.0 ? vec3(0.72, 0.46, 0.85) : vec3(0.30, 0.74, 0.80);
        gl_FragDepth = depthAt(p);
        outColor = vec4(base * (0.35 + 0.75 * dv), 1.0);
        return;
      }
    }
    float q = waterAt(p);
    if (q >= uThreshold) {
      // Refine the crossing by one linear step.
      float frac = (uThreshold - prev) / max(q - prev, 1.0e-6);
      p = ro + rd * (t - dt * (1.0 - clamp(frac, 0.0, 1.0)));

      // Where the field is flat the gradient is numerical noise, and
      // normalising it gives every pixel a different random normal. Face the
      // viewer instead: a featureless sheet should look like one.
      vec3 grad = -gradient(p, 1.0 / 128.0);
      float glen = length(grad);
      vec3 n = glen > 1.0e-3 * max(uThreshold, 1.0e-3) ? grad / glen : -rd;
      float diff = max(dot(n, uSun), 0.0);
      float sky = 0.5 + 0.5 * n.y;
      vec4 s = sampleField(p);
      float rainFrac = (s.r + s.g > 1.0e-6) ? s.g / (s.r + s.g) : 0.0;
      vec3 albedo = (uFieldSel == 4)
        ? dbzColor(s.a)
        : mix(CLOUD_BRIGHT, RAIN_TINT, rainFrac);
      vec3 col;
      if (uCloudGrey > 0.5 && uFieldSel != 4) {
        // Bare matte grey, lit from above: how a visualiser draws an
        // iso-surface with no material of its own.
        float v = 0.05 + 0.27 * sky + 0.72 * diff;
        col = vec3(clamp(v, 0.0, 1.0));
      } else {
        col = albedo * (0.22 * SKY_AMBIENT * sky + 0.95 * diff) +
              CLOUD_SHADE * 0.25;
        float rim = pow(1.0 - abs(dot(n, -rd)), 3.0);
        col += SKY_AMBIENT * rim * 0.35;
      }

      if (uShowUpdraft > 0.5) {
        float wn = clamp(s.b / uWMax, -1.0, 1.0);
        col = mix(col, wn > 0.0 ? UP_TINT : DOWN_TINT, abs(wn) * 0.35);
      }

      if (uMode == 2) {
        // Procedural grid lines on the surface: the model's own cells.
        vec3 g = fract((p + 0.5) * uGridCells);
        vec3 d = min(g, 1.0 - g);
        float line = min(min(d.x, d.y), d.z);
        float wline = fwidth(line) * 1.5 + 1.0e-4;
        float m = smoothstep(0.0, wline, line);
        col = mix(vec3(0.05, 0.07, 0.10), col * 0.55 + 0.18, m);
      }
      gl_FragDepth = depthAt(p);
      outColor = vec4(col, 1.0);
      return;
    }
    prev = q;
  }
  discard;
}
`;

export interface VolumeUniforms {
  uField: { value: THREE.Data3DTexture | null };
  uCamLocal: { value: THREE.Vector3 };
  uSun: { value: THREE.Vector3 };
  uDensity: { value: number };
  uThreshold: { value: number };
  uSteps: { value: number };
  uMode: { value: number };
  uFieldSel: { value: number };
  uShowUpdraft: { value: number };
  uGridCells: { value: THREE.Vector3 };
  uWMax: { value: number };
  uContourStep: { value: number };
  uVort: { value: THREE.Data3DTexture | null };
  uCloudGrey: { value: number };
  uPalette: { value: number };
  uShowVortex: { value: number };
  uVortLevel: { value: number };
}

export function createVolumeMaterial(): THREE.ShaderMaterial {
  const uniforms: VolumeUniforms = {
    uField: { value: null },
    uCamLocal: { value: new THREE.Vector3() },
    uSun: { value: new THREE.Vector3(0.5, 0.6, 0.6).normalize() },
    uDensity: { value: 1 },
    uThreshold: { value: 0.05 },
    uSteps: { value: 160 },
    uMode: { value: 0 },
    uFieldSel: { value: 2 },
    uShowUpdraft: { value: 1 },
    uGridCells: { value: new THREE.Vector3(48, 48, 40) },
    uWMax: { value: 20 },
    uContourStep: { value: 0 },
    uVort: { value: null },
    uCloudGrey: { value: 0 },
    uPalette: { value: 0 },
    uShowVortex: { value: 0 },
    uVortLevel: { value: 0.02 },
  };
  return new THREE.ShaderMaterial({
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    glslVersion: THREE.GLSL3,
  });
}
