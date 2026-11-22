import "./style.css";
import { defaultConfig, cloneConfig, type Config } from "./core/config";
import { parseInputSounding } from "./core/sounding";
import { SceneView } from "./render/renderer";
import { Panel } from "./ui/panel";
import { SCHEMA } from "./ui/schema";
import { PRESETS, configFromPreset } from "./ui/presets";
import { SoundingPlot } from "./ui/soundingPlot";
import SimWorker from "./worker/sim.worker?worker";
import type { BaseStateMessage, FromWorker, ToWorker } from "./worker/sim.worker";
import type { Diagnostics } from "./core/solver";

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

// --- configuration, possibly restored from the URL ------------------------
function configFromHash(): Config | null {
  const h = location.hash.replace(/^#/, "");
  if (!h.startsWith("c=")) return null;
  try {
    const json = decodeURIComponent(escape(atob(h.slice(2).replace(/-/g, "+").replace(/_/g, "/"))));
    const parsed = JSON.parse(json) as Partial<Config>;
    return { ...defaultConfig(), ...parsed } as Config;
  } catch {
    return null;
  }
}

function hashFromConfig(c: Config): string {
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(c))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `#c=${b64}`;
}

let cfg: Config = configFromHash() ?? defaultConfig();

// --- scene, panel, diagram -------------------------------------------------
const view = new SceneView($<HTMLCanvasElement>("gl"));
view.setGrid(cfg.grid, cfg.render.exaggerateZ);
view.applyRenderConfig(cfg.render);

const plot = new SoundingPlot($<HTMLCanvasElement>("sounding"));

const worker = new SimWorker();
const send = (m: ToWorker, transfer?: Transferable[]) =>
  worker.postMessage(m, transfer ?? []);

let base: BaseStateMessage | null = null;
let diag: Diagnostics | null = null;
let msPerStep = 0;
let running = false;
let lastFrameWall = performance.now();
let renderFps = 0;

const panel = new Panel($("panel"), cfg, SCHEMA, (rebuild) => {
  view.applyRenderConfig(cfg.render);
  if (rebuild) {
    view.setGrid(cfg.grid, cfg.render.exaggerateZ);
    send({ type: "config", cfg, rebuild: true });
  } else {
    send({ type: "config", cfg, rebuild: false });
  }
  updateHud();
});

// --- preset list -----------------------------------------------------------
const presetSel = $<HTMLSelectElement>("preset");
{
  const custom = document.createElement("option");
  custom.value = "";
  custom.textContent = "— preset —";
  presetSel.appendChild(custom);
  for (const p of PRESETS) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.name;
    o.title = p.note;
    presetSel.appendChild(o);
  }
}
presetSel.addEventListener("change", () => {
  if (!presetSel.value) return;
  cfg = configFromPreset(presetSel.value);
  applyWholeConfig();
});

function applyWholeConfig(): void {
  // The panel holds a live reference, so rebuild it against the new object.
  const p = new Panel($("panel"), cfg, SCHEMA, (rebuild) => {
    view.applyRenderConfig(cfg.render);
    if (rebuild) view.setGrid(cfg.grid, cfg.render.exaggerateZ);
    send({ type: "config", cfg, rebuild });
    updateHud();
  });
  void p;
  view.setGrid(cfg.grid, cfg.render.exaggerateZ);
  view.applyRenderConfig(cfg.render);
  send({ type: "config", cfg, rebuild: true });
}

// --- worker messages -------------------------------------------------------
worker.onmessage = (ev: MessageEvent<FromWorker>) => {
  const m = ev.data;
  if (m.type === "base") {
    base = m.base;
    plot.setBase(m.base);
    $("sndtext").textContent ||= "";
    updateIndices();
    updateHud();
  } else if (m.type === "frame") {
    diag = m.diag;
    msPerStep = m.msPerStep;
    const data = new Float32Array(m.buf);
    view.updateField(data, Math.max(Math.abs(m.diag.maxW), Math.abs(m.diag.minW)));
    send({ type: "recycle", buf: m.buf }, [m.buf]);
    updateHud();
    if (!m.diag.stable) {
      running = false;
      $("run").textContent = "Run";
      showWarn(
        "The integration went unstable. Lower dt, raise the acoustic substeps or add diffusion, then Reset."
      );
    }
  } else if (m.type === "error") {
    showWarn(m.message);
  }
};

send({ type: "init", cfg });

// --- heads-up display ------------------------------------------------------
function fmt(x: number, d = 1): string {
  return x.toFixed(d).padStart(7);
}

function updateHud(): void {
  const h = $("hud");
  if (!diag) {
    h.textContent = "initialising…";
    return;
  }
  const t = diag.time;
  const mm = Math.floor(t / 60);
  const ss = Math.floor(t % 60);
  const acCfl = base
    ? (cfg.numerics.dt / Math.max(cfg.numerics.acousticSteps, 1)) /
      base.maxAcousticDt
    : 0;
  h.textContent = [
    `t         ${String(mm).padStart(3)}:${String(ss).padStart(2, "0")}   step ${diag.steps}`,
    `w         ${fmt(diag.maxW, 2)} / ${diag.minW.toFixed(2)} m/s`,
    `qc max    ${fmt(diag.maxQc, 3)} g/kg`,
    `qr max    ${fmt(diag.maxQr, 3)} g/kg`,
    `theta'    ${fmt(diag.maxThetaPert, 2)} K`,
    `cloud top ${fmt(diag.cloudTop / 1000, 2)} km`,
    `rain      ${fmt(diag.maxRainAccum, 2)} mm max`,
    `CFL adv   ${fmt(diag.cfl, 2)}     acoustic ${acCfl.toFixed(2)}`,
    `speed     ${msPerStep.toFixed(0)} ms/step · ${(
      cfg.numerics.dt / (msPerStep / 1000)
    ).toFixed(0)}x realtime · ${renderFps.toFixed(0)} fps`,
  ].join("\n");

  if (diag.cfl > 1.2)
    showWarn("Advective CFL above 1.2 — reduce dt or coarsen the grid.");
  else if (acCfl > 1 && !cfg.numerics.autoAcoustic)
    showWarn(
      "Acoustic CFL above 1 — raise the substep count or turn auto substeps on."
    );
  else if (diag.stable) hideWarn();
}

let warnTimer = 0;
function showWarn(msg: string): void {
  const w = $("warn");
  w.textContent = msg;
  w.hidden = false;
  clearTimeout(warnTimer);
  warnTimer = window.setTimeout(() => (w.hidden = true), 6000);
}
function hideWarn(): void {
  $("warn").hidden = true;
}

function updateIndices(): void {
  if (!base) return;
  const b = base;
  const g = (x: number, d = 0, u = "") =>
    isFinite(x) ? `${x.toFixed(d)}${u}` : "—";
  $("indices").textContent = [
    `CAPE      ${g(b.cape, 0)} J/kg      CIN  ${g(b.cin, 0)} J/kg`,
    `LCL       ${g(b.lclZ, 0)} m         LFC  ${g(b.lfcZ, 0)} m`,
    `EL        ${g(b.elZ, 0)} m          LI   ${g(b.liftedIndex, 1)} K`,
    `PWAT      ${g(b.pwat, 1)} mm`,
    `shear 0-1 ${g(b.shear1, 1)} m/s     0-6  ${g(b.shear6, 1)} m/s`,
    `SRH 0-3   ${g(b.srh3, 0)} m2/s2`,
    `sound c   ${g(b.soundSpeed, 0)} m/s  max acoustic dt ${g(b.maxAcousticDt, 2)} s`,
  ].join("\n");
}

// --- buttons ---------------------------------------------------------------
$("run").addEventListener("click", () => {
  running = !running;
  $("run").textContent = running ? "Pause" : "Run";
  send({ type: "run", running });
});
$("step1").addEventListener("click", () => send({ type: "steps", n: 1 }));
$("step60").addEventListener("click", () =>
  send({ type: "steps", n: Math.max(1, Math.round(60 / cfg.numerics.dt)) })
);
$("reset").addEventListener("click", () => {
  running = false;
  $("run").textContent = "Run";
  send({ type: "run", running: false });
  send({ type: "reset" });
});
$("share").addEventListener("click", async () => {
  location.hash = hashFromConfig(cfg);
  try {
    await navigator.clipboard.writeText(location.href);
    showWarn("Link copied — it carries the whole configuration.");
  } catch {
    showWarn("Configuration is in the address bar.");
  }
});
$("png").addEventListener("click", () => {
  const a = document.createElement("a");
  a.href = view.snapshot();
  a.download = `cumulo-${Math.round(diag?.time ?? 0)}s.png`;
  a.click();
});

const sndText = $<HTMLTextAreaElement>("sndtext");
$("snddump").addEventListener("click", () => {
  if (base) sndText.value = base.inputSounding;
});
$("sndload").addEventListener("click", () => {
  try {
    const parsed = parseInputSounding(sndText.value);
    cfg.sounding.mode = "table";
    cfg.sounding.windMode = "table";
    cfg.sounding.psfc = parsed.psfc;
    cfg.sounding.levels = parsed.levels;
    panel.refresh();
    send({ type: "config", cfg, rebuild: true });
    showWarn(`Loaded ${parsed.levels.length} levels.`);
  } catch (e) {
    showWarn(`Could not read the sounding: ${(e as Error).message}`);
  }
});
$("cfgdump").addEventListener("click", () => {
  sndText.value = JSON.stringify(cfg, null, 2);
});
$("cfgload").addEventListener("click", () => {
  try {
    cfg = { ...defaultConfig(), ...(JSON.parse(sndText.value) as Config) };
    applyWholeConfig();
    showWarn("Configuration applied.");
  } catch (e) {
    showWarn(`Not valid JSON: ${(e as Error).message}`);
  }
});

window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement)
    return;
  if (e.code === "Space") {
    e.preventDefault();
    $("run").click();
  } else if (e.key === "r") $("reset").click();
  else if (e.key === "s") send({ type: "steps", n: 1 });
});

// --- render loop -----------------------------------------------------------
function frame(): void {
  const now = performance.now();
  renderFps = renderFps * 0.9 + (1000 / Math.max(now - lastFrameWall, 1)) * 0.1;
  lastFrameWall = now;
  view.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Keep a pristine copy around for debugging from the console.
(window as unknown as { cumulo: unknown }).cumulo = {
  get config() {
    return cloneConfig(cfg);
  },
  get diagnostics() {
    return diag;
  },
  get base() {
    return base;
  },
};
