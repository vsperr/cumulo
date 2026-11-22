import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { createVolumeMaterial } from "./volume";
import type { GridConfig, RenderConfig } from "../core/config";

const FIELD_INDEX: Record<RenderConfig["field"], number> = {
  cloud: 0,
  rain: 1,
  total: 2,
  updraft: 3,
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
    vertexShader: /* glsl */ `
      varying float vH;
      void main() {
        vH = normalize(position).y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying float vH;
      void main() {
        float t = clamp(vH * 0.5 + 0.5, 0.0, 1.0);
        vec3 low  = vec3(0.045, 0.055, 0.075);
        vec3 mid  = vec3(0.075, 0.095, 0.135);
        vec3 high = vec3(0.025, 0.035, 0.055);
        vec3 c = t < 0.5 ? mix(low, mid, t * 2.0) : mix(mid, high, (t - 0.5) * 2.0);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  return m;
}

export class SceneView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;

  private volumeMesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;
  private texture: THREE.Data3DTexture | null = null;
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

    this.scene.add(createBackdrop());
    this.scene.add(this.groundHolder);

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

  resize(): void {
    const c = this.renderer.domElement;
    const w = c.clientWidth || 1;
    const h = c.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
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

    if (changed) {
      this.texture?.dispose();
      const data = new Float32Array(nx * ny * nz * 4);
      const tex = new THREE.Data3DTexture(data, nx, ny, nz);
      tex.format = THREE.RGBAFormat;
      tex.type = THREE.FloatType;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.wrapR = THREE.ClampToEdgeWrapping;
      tex.unpackAlignment = 1;
      tex.needsUpdate = true;
      this.texture = tex;
      this.material.uniforms.uField.value = tex;
    }
  }

  /** Upload a frame: interleaved RGBA = cloud [g/kg], rain [g/kg], w [m/s]. */
  updateField(data: Float32Array, wMax: number): void {
    if (!this.texture) return;
    const img = this.texture.image.data as unknown as Float32Array;
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
    this.material.transparent = r.mode === "volume";
    this.material.depthWrite = r.mode !== "volume";
    this.boxEdges.visible = r.showBox;
    this.groundHolder.visible = r.showGround;

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
