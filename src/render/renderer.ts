import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { createVolumeMaterial } from "./volume";
import type { GridConfig, RenderConfig } from "../core/config";

const FIELD_INDEX: Record<RenderConfig["field"], number> = {
  cloud: 0,
  rain: 1,
  total: 2,
  updraft: 3,
  reflectivity: 4,
};
const MODE_INDEX: Record<RenderConfig["mode"], number> = {
  volume: 0,
  surface: 1,
  wire: 2,
};

/** Procedural sky backdrop: a gradient, not an image. */
function createBackdrop(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(60, 24, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { uDay: { value: 0 } },
    vertexShader: /* glsl */ `
      varying float vH;
      void main() {
        vH = normalize(position).y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying float vH;
      uniform float uDay;
      void main() {
        float t = clamp(vH * 0.5 + 0.5, 0.0, 1.0);
        vec3 c;
        if (uDay > 0.5) {
          // The flat daylight blue a visualiser puts behind a CM1 figure.
          c = mix(vec3(0.42, 0.68, 0.85), vec3(0.22, 0.56, 0.82), t);
        } else {
          vec3 low  = vec3(0.045, 0.055, 0.075);
          vec3 mid  = vec3(0.075, 0.095, 0.135);
          vec3 high = vec3(0.025, 0.035, 0.055);
          c = t < 0.5 ? mix(low, mid, t * 2.0) : mix(mid, high, (t - 0.5) * 2.0);
        }
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  return m;
}

/**
 * The reflectivity slice that lies on the ground under the storm, the way CM1
 * figures pair a bare cloud iso-surface with a coloured precipitation field.
 * It samples the same data volume the cloud does, at one model level.
 */
function createGroundRadar(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    depthWrite: true,
    // Visible from underneath too: looking up at the storm is a normal thing
    // to want, and a one-sided plane simply vanishes from below.
    side: THREE.DoubleSide,
    uniforms: {
      uField: { value: null as THREE.Data3DTexture | null },
      uLevel: { value: 0.02 },
      uPalette: { value: 1 },
    },
    vertexShader: /* glsl */ `
      out vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      precision highp sampler3D;
      in vec2 vUv;
      out vec4 outColor;
      uniform sampler3D uField;
      uniform float uLevel;
      uniform float uPalette;

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
      vec3 bandColor(float d) {
        if (d <  5.0) return vec3(0.04, 0.06, 0.09);
        if (d < 10.0) return vec3(0.016, 0.914, 0.906);
        if (d < 15.0) return vec3(0.004, 0.624, 0.957);
        if (d < 20.0) return vec3(0.012, 0.000, 0.957);
        if (d < 25.0) return vec3(0.008, 0.992, 0.008);
        if (d < 30.0) return vec3(0.004, 0.773, 0.004);
        if (d < 35.0) return vec3(0.000, 0.557, 0.000);
        if (d < 40.0) return vec3(0.992, 0.973, 0.008);
        if (d < 45.0) return vec3(0.898, 0.737, 0.000);
        if (d < 50.0) return vec3(0.992, 0.584, 0.000);
        if (d < 55.0) return vec3(0.992, 0.000, 0.000);
        if (d < 60.0) return vec3(0.831, 0.000, 0.000);
        if (d < 65.0) return vec3(0.737, 0.000, 0.000);
        if (d < 70.0) return vec3(0.973, 0.000, 0.992);
        return vec3(0.596, 0.329, 0.776);
      }

      void main() {
        // Volume axes are (east, north, up); the plane's v runs south.
        float d = texture(uField, vec3(vUv.x, 1.0 - vUv.y, uLevel)).a;
        outColor = vec4(uPalette > 0.5 ? cm1Color(d) : bandColor(d), 1.0);
      }`,
  });
  return new THREE.Mesh(geo, mat);
}

export class SceneView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;

  private volumeMesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;
  private texture: THREE.Data3DTexture | null = null;
  private vortTexture: THREE.Data3DTexture | null = null;
  private backdrop: THREE.Mesh;
  private groundRadar: THREE.Mesh;
  private boxEdges: THREE.LineSegments;
  private ground: THREE.GridHelper | null = null;
  private groundHolder = new THREE.Group();
  private grid: GridConfig | null = null;
  private scale = 1;
  private boxSize = new THREE.Vector3(1, 1, 1);

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.01, 200);
    this.camera.position.set(2.6, 1.7, 3.0);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxDistance = 30;
    this.controls.minDistance = 0.4;

    this.backdrop = createBackdrop();
    this.scene.add(this.backdrop);
    this.scene.add(this.groundHolder);
    this.groundRadar = createGroundRadar();
    this.groundRadar.visible = false;
    this.scene.add(this.groundRadar);

    this.material = createVolumeMaterial();
    this.volumeMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.material);
    this.volumeMesh.frustumCulled = false;
    this.scene.add(this.volumeMesh);

    const edgeGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    this.boxEdges = new THREE.LineSegments(
      edgeGeo,
      new THREE.LineBasicMaterial({ color: 0x3a4a63, transparent: true, opacity: 0.85 })
    );
    this.scene.add(this.boxEdges);

    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  /**
   * Cap the device pixel ratio. Ray marching costs a fragment shader run per
   * pixel per sample, so a phone's 3x display is the single most expensive
   * thing about this view.
   */
  setPixelRatioCap(cap: number): void {
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, cap));
    this.resize();
  }

  /** Vertical field of view on a wide screen; narrow screens widen it. */
  private baseFov = 42;

  resize(): void {
    const c = this.renderer.domElement;
    const w = c.clientWidth || 1;
    const h = c.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    this.camera.aspect = aspect;
    // On a portrait screen a fixed vertical FOV crops the domain horizontally.
    // Hold the *horizontal* field of view instead, so the box always fits.
    if (aspect < 1) {
      const halfH = Math.tan((this.baseFov * Math.PI) / 360);
      const fov = (2 * Math.atan(halfH / aspect) * 180) / Math.PI;
      this.camera.fov = Math.min(fov, 80);
    } else {
      this.camera.fov = this.baseFov;
    }
    this.camera.updateProjectionMatrix();
  }

  /** Lay out the domain box and (re)allocate the data volume. */
  setGrid(grid: GridConfig, exaggerateZ: number): void {
    const { nx, ny, nz, dx, dy, dz } = grid;
    const changed =
      !this.grid ||
      this.grid.nx !== nx ||
      this.grid.ny !== ny ||
      this.grid.nz !== nz;
    this.grid = { ...grid };

    const Lx = nx * dx;
    const Ly = ny * dy;
    const Lz = nz * dz;
    this.scale = 2 / Math.max(Lx, Ly);
    this.boxSize.set(
      Lx * this.scale,
      Lz * this.scale * exaggerateZ,
      Ly * this.scale
    );
    const half = this.boxSize.y / 2;
    this.volumeMesh.scale.copy(this.boxSize);
    this.volumeMesh.position.set(0, half, 0);
    this.boxEdges.scale.copy(this.boxSize);
    this.boxEdges.position.set(0, half, 0);
    this.controls.target.set(0, half * 0.55, 0);

    if (this.ground) {
      this.groundHolder.remove(this.ground);
      this.ground.geometry.dispose();
    }
    const divisions = Math.min(Math.max(nx, ny), 64);
    this.ground = new THREE.GridHelper(
      Math.max(this.boxSize.x, this.boxSize.z),
      divisions,
      0x2b3a4f,
      0x1b2533
    );
    this.ground.position.y = 0.0005;
    this.groundHolder.add(this.ground);

    (this.material.uniforms.uGridCells.value as THREE.Vector3).set(nx, ny, nz);
    if (changed) this.frameDomain();

    this.groundRadar.scale.set(this.boxSize.x, 1, this.boxSize.z);
    this.groundRadar.position.set(0, 0.0012, 0);

    if (changed) {
      this.texture?.dispose();
      this.vortTexture?.dispose();
      const data = new Uint16Array(nx * ny * nz * 4);
      const tex = new THREE.Data3DTexture(data, nx, ny, nz);
      tex.format = THREE.RGBAFormat;
      tex.type = THREE.HalfFloatType;
      tex.minFilter = THREE.NearestFilter;
      tex.magFilter = THREE.NearestFilter;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.wrapR = THREE.ClampToEdgeWrapping;
      tex.unpackAlignment = 1;
      tex.needsUpdate = true;
      this.texture = tex;
      this.material.uniforms.uField.value = tex;
      (this.groundRadar.material as THREE.ShaderMaterial).uniforms.uField.value = tex;

      const vdata = new Uint16Array(nx * ny * nz);
      const vtex = new THREE.Data3DTexture(vdata, nx, ny, nz);
      vtex.format = THREE.RedFormat;
      vtex.type = THREE.HalfFloatType;
      vtex.minFilter = THREE.LinearFilter;
      vtex.magFilter = THREE.LinearFilter;
      vtex.wrapS = THREE.ClampToEdgeWrapping;
      vtex.wrapT = THREE.ClampToEdgeWrapping;
      vtex.wrapR = THREE.ClampToEdgeWrapping;
      vtex.unpackAlignment = 1;
      vtex.needsUpdate = true;
      this.vortTexture = vtex;
      this.material.uniforms.uVort.value = vtex;
    }
  }

  /** Place the camera so the whole domain is comfortably in shot. */
  frameDomain(): void {
    const b = this.boxSize;
    const radius = 0.5 * Math.hypot(b.x, b.y, b.z);
    const vFov = (this.camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.min(this.camera.aspect, 1));
    const dist = (radius * 1.12) / Math.sin(Math.max(Math.min(vFov, hFov), 0.2) / 2);
    const dir = new THREE.Vector3(0.62, 0.42, 0.72).normalize();
    const target = new THREE.Vector3(0, b.y * 0.5, 0);
    this.camera.position.copy(target).addScaledVector(dir, dist);
    this.controls.target.copy(target);
    this.controls.update();
  }

  /**
   * Interpolate between cells, or show them as they are. Linear filtering
   * invents values between grid points, which looks soft but is not what the
   * model computed; nearest shows exactly the cells the solver advanced.
   */
  /** Upload the vertical vorticity volume. */
  updateVorticity(data: Uint16Array): void {
    if (!this.vortTexture) return;
    const img = this.vortTexture.image.data as unknown as Uint16Array;
    if (img.length !== data.length) return;
    img.set(data);
    this.vortTexture.needsUpdate = true;
  }

  setSmoothing(smooth: boolean): void {
    if (!this.texture) return;
    const f = smooth ? THREE.LinearFilter : THREE.NearestFilter;
    if (this.texture.minFilter === f) return;
    this.texture.minFilter = f;
    this.texture.magFilter = f;
    this.texture.needsUpdate = true;
  }

  /**
   * Upload a frame: interleaved RGBA half floats = cloud [g/kg], rain [g/kg],
   * w [m/s].
   */
  updateField(data: Uint16Array, wMax: number): void {
    if (!this.texture) return;
    const img = this.texture.image.data as unknown as Uint16Array;
    if (img.length !== data.length) return;
    img.set(data);
    this.texture.needsUpdate = true;
    this.material.uniforms.uWMax.value = Math.max(wMax, 1);
  }

  applyRenderConfig(r: RenderConfig): void {
    const u = this.material.uniforms;
    u.uMode.value = MODE_INDEX[r.mode];
    u.uFieldSel.value = FIELD_INDEX[r.field];
    u.uThreshold.value = r.threshold;
    u.uDensity.value = r.density;
    u.uSteps.value = Math.min(Math.max(r.steps, 16), 512);
    u.uShowUpdraft.value = r.showUpdraft ? 1 : 0;
    u.uContourStep.value = Math.max(r.contourStep, 0);
    u.uCloudGrey.value = r.cloudGrey ? 1 : 0;
    u.uPalette.value = r.palette === "cm1" ? 1 : 0;
    u.uShowVortex.value = r.showVortex ? 1 : 0;
    u.uVortLevel.value = Math.max(r.vortexLevel, 1e-4);
    this.setSmoothing(r.smooth);

    (this.backdrop.material as THREE.ShaderMaterial).uniforms.uDay.value =
      r.sky === "day" ? 1 : 0;

    const gm = this.groundRadar.material as THREE.ShaderMaterial;
    this.groundRadar.visible = r.groundRadar;
    gm.uniforms.uPalette.value = r.palette === "cm1" ? 1 : 0;
    const nz = this.grid?.nz ?? 1;
    gm.uniforms.uLevel.value = (Math.min(r.groundLevel, nz - 1) + 0.5) / nz;
    this.material.transparent = r.mode === "volume";
    this.material.depthWrite = r.mode !== "volume";
    this.boxEdges.visible = r.showBox;
    this.groundHolder.visible = r.showGround && !r.groundRadar;

    const az = (r.sunAzimuth * Math.PI) / 180;
    const el = (r.sunElevation * Math.PI) / 180;
    (u.uSun.value as THREE.Vector3)
      .set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az))
      .normalize();
    if (this.grid) this.setGrid(this.grid, r.exaggerateZ);
  }

  render(): void {
    this.controls.update();
    const camLocal = this.volumeMesh.worldToLocal(this.camera.position.clone());
    (this.material.uniforms.uCamLocal.value as THREE.Vector3).copy(camLocal);
    this.renderer.render(this.scene, this.camera);
  }

  /** Current canvas as a PNG data URL (for the screenshot button). */
  snapshot(): string {
    this.render();
    return this.renderer.domElement.toDataURL("image/png");
  }
}
