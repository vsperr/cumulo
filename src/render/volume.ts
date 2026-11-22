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

uniform sampler3D uField;
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

// Water content [g/kg] at a point, according to the selected field.
float waterAt(vec3 p) {
  vec4 s = sampleField(p);
  if (uFieldSel == 0) return s.r;
  if (uFieldSel == 1) return s.g;
  if (uFieldSel == 3) return abs(s.b);
  return s.r + s.g;
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

  if (uMode == 0) {
    // --- volumetric absorption + single scattering ---
    vec3 acc = vec3(0.0);
    float trans = 1.0;
    float sunStep = 1.6 / 6.0;
    for (int i = 0; i < 512; i++) {
      if (i >= uSteps || trans < 0.004) break;
      float t = t0 + (float(i) + 0.5) * dt;
      vec3 p = ro + rd * t;
      vec4 s = sampleField(p);
      float q = (uFieldSel == 0) ? s.r : (uFieldSel == 1) ? s.g
              : (uFieldSel == 3) ? abs(s.b) : (s.r + s.g);
      if (q < 1.0e-3) continue;

      float sigma = q * uDensity * 3.0;
      float a = 1.0 - exp(-sigma * dt * 60.0);

      float tau = sunDepth(p, sunStep) * uDensity * 3.0 * 12.0;
      float light = exp(-tau);
      float rainFrac = (s.r + s.g > 1.0e-6) ? s.g / (s.r + s.g) : 0.0;
      vec3 albedo = mix(CLOUD_BRIGHT, RAIN_TINT, rainFrac);
      vec3 col = albedo * (SKY_AMBIENT * 0.42 + vec3(1.0, 0.96, 0.88) * light);
      col = mix(CLOUD_SHADE * albedo, col, 0.18 + 0.82 * light);

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
    outColor = vec4(acc / max(alpha, 1.0e-4), alpha);
    return;
  }

  // --- iso-surface: first crossing of the threshold, flat analytic shading ---
  float prev = 0.0;
  for (int i = 0; i < 512; i++) {
    if (i >= uSteps) break;
    float t = t0 + (float(i) + 0.5) * dt;
    vec3 p = ro + rd * t;
    float q = waterAt(p);
    if (q >= uThreshold) {
      // Refine the crossing by one linear step.
      float frac = (uThreshold - prev) / max(q - prev, 1.0e-6);
      p = ro + rd * (t - dt * (1.0 - clamp(frac, 0.0, 1.0)));

      vec3 n = normalize(-gradient(p, 1.0 / 128.0) + vec3(1.0e-6));
      float diff = max(dot(n, uSun), 0.0);
      float sky = 0.5 + 0.5 * n.y;
      vec4 s = sampleField(p);
      float rainFrac = (s.r + s.g > 1.0e-6) ? s.g / (s.r + s.g) : 0.0;
      vec3 albedo = mix(CLOUD_BRIGHT, RAIN_TINT, rainFrac);
      vec3 col = albedo * (0.22 * SKY_AMBIENT * sky + 0.95 * diff) +
                 CLOUD_SHADE * 0.25;
      float rim = pow(1.0 - abs(dot(n, -rd)), 3.0);
      col += SKY_AMBIENT * rim * 0.35;

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
