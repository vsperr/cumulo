import "./style.css";
import { defaultConfig, cloneConfig, type Config } from "./core/config";
import { parseInputSounding } from "./core/sounding";
import { SceneView } from "./render/renderer";
import { Panel } from "./ui/panel";
import { SCHEMA } from "./ui/schema";
import { SCHEMA_BASIC } from "./ui/schemaBasic";
import { PRESETS, configFromPreset } from "./ui/presets";
import { SoundingPlot } from "./ui/soundingPlot";
import { WorldMap, type MapPoint } from "./ui/worldMap";
import {
  MODELS,
  fetchColumn,
  soundingAt,
  formatTime,
  nearestHour,
  RateLimited,
  type RemoteColumn,
} from "./core/remoteSounding";
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

const sharedLink = location.hash.startsWith("#c=");
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

let panel: Panel;

/** Rebuild the control panel for the current config and UI mode. */
function rebuildPanel(): void {
  document.body.dataset.ui = cfg.ui.expert ? "expert" : "basic";
  $("uimode").textContent = cfg.ui.expert ? "Simple view" : "All parameters";
  panel = new Panel(
    $("panel"),
    cfg,
    cfg.ui.expert ? SCHEMA : SCHEMA_BASIC,
    (rebuild) => {
      view.applyRenderConfig(cfg.render);
      if (rebuild) view.setGrid(cfg.grid, cfg.render.exaggerateZ);
      send({ type: "config", cfg, rebuild });
      updateHud();
    }
  );
}
rebuildPanel();

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
  const expert = cfg.ui.expert;
  cfg = configFromPreset(presetSel.value);
  cfg.ui.expert = expert;
  const note = PRESETS.find((p) => p.id === presetSel.value)?.note ?? "";
  $("presetnote").textContent = note;
  applyWholeConfig();
});

function applyWholeConfig(): void {
  // The panel holds a live reference to the config, so rebuild it.
  rebuildPanel();
  view.setGrid(cfg.grid, cfg.render.exaggerateZ);
  view.applyRenderConfig(cfg.render);
  send({ type: "config", cfg, rebuild: true });
}

$("uimode").addEventListener("click", () => {
  cfg.ui.expert = !cfg.ui.expert;
  rebuildPanel();
  updateHud();
  updateIndices();
});

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


// --- real soundings from forecast models ----------------------------------
let column: RemoteColumn | null = null;
let fetchAbort: AbortController | null = null;
let point: MapPoint = { lat: 35.22, lon: -97.44 }; // Norman, Oklahoma

const latInput = $<HTMLInputElement>("lat");
const lonInput = $<HTMLInputElement>("lon");
const modelSel = $<HTMLSelectElement>("model");
const hourInput = $<HTMLInputElement>("hour");

for (const m of MODELS) {
  const o = document.createElement("option");
  o.value = m.id;
  o.textContent = m.name;
  o.title = m.note;
  modelSel.appendChild(o);
}
modelSel.value = "icon_seamless";

function setStatus(text: string, kind: "" | "busy" | "bad" | "good" = ""): void {
  const el = $("realstatus");
  el.textContent = text;
  el.className = `note ${kind}`;
}

function syncPointInputs(): void {
  latInput.value = point.lat.toFixed(2);
  lonInput.value = point.lon.toFixed(2);
}

let loadTimer = 0;
/** Clicking around the map should not fire a request per click. */
function scheduleLoad(delay = 350): void {
  clearTimeout(loadTimer);
  loadTimer = window.setTimeout(() => void loadColumn(), delay);
}

const map = new WorldMap($<HTMLCanvasElement>("map"), (p) => {
  point = p;
  syncPointInputs();
  setStatus("Picked. Fetching…", "busy");
  scheduleLoad();
});
syncPointInputs();
map.setPoint(point, true);

for (const el of [latInput, lonInput]) {
  el.addEventListener("change", () => {
    const lat = Number(latInput.value);
    const lon = Number(lonInput.value);
    if (!isFinite(lat) || !isFinite(lon)) return;
    point = { lat: Math.max(-89, Math.min(89, lat)), lon };
    syncPointInputs();
    map.setPoint(point, true);
    scheduleLoad();
  });
}
modelSel.addEventListener("change", () => scheduleLoad(0));
$("fetch").addEventListener("click", () => scheduleLoad(0));

hourInput.addEventListener("input", () => {
  if (!column) return;
  applySounding(Number(hourInput.value));
});

/** Download the forecast column for the chosen point and model. */
async function loadColumn(): Promise<void> {
  fetchAbort?.abort();
  const ctl = new AbortController();
  fetchAbort = ctl;
  const name = MODELS.find((m) => m.id === modelSel.value)?.name ?? modelSel.value;
  setStatus(`Fetching ${name} at ${point.lat.toFixed(2)}, ${point.lon.toFixed(2)}…`, "busy");
  try {
    const col = await fetchColumn(point.lat, point.lon, modelSel.value, 1, ctl.signal);
    column = col;
    hourInput.max = String(col.times.length - 1);
    const h = nearestHour(col.times);
    hourInput.value = String(h);
    applySounding(h);
  } catch (e) {
    const err = e as Error;
    if (err.name === "AbortError") return;
    column = null;
    if (err instanceof RateLimited || err.name === "RateLimited") {
      setStatus(`Hold on — ${err.message}.`, "bad");
      return;
    }
    setStatus(
      `Could not load a sounding: ${err.message}. The regional models (ICON-D2, ICON-EU, ARPEGE) only cover their own area — try ICON global or GFS.`,
      "bad"
    );
  }
}

/** Push one hour of the downloaded column into the model as a level table. */
function applySounding(hour: number): void {
  if (!column) return;
  const snd = soundingAt(column, hour);
  $("hourlabel").textContent = formatTime(snd.time);
  if (snd.levels.length < 4) {
    setStatus("That point has too few levels above the terrain.", "bad");
    return;
  }
  cfg.sounding.mode = "table";
  cfg.sounding.windMode = "table";
  cfg.sounding.easy = false;
  cfg.sounding.psfc = snd.psfc;
  cfg.sounding.levels = snd.levels;
  rebuildPanel();
  send({ type: "config", cfg, rebuild: true });

  const domainTop = cfg.grid.nz * cfg.grid.dz;
  const parts = [
    `${column.modelName} · ${formatTime(snd.time)}`,
    `${column.lat.toFixed(2)}, ${column.lon.toFixed(2)} · ground ${snd.elevation.toFixed(0)} m · ${snd.levels.length} levels`,
    isFinite(snd.sourceCape)
      ? `Forecast CAPE ${snd.sourceCape.toFixed(0)} J/kg at the sounding's own resolution. The figure below is what this grid resolves — coarse levels always resolve less.`
      : "",
  ];
  if (isFinite(snd.sourceEl) && snd.sourceEl > domainTop)
    parts.push(
      `The storm top would be near ${(snd.sourceEl / 1000).toFixed(1)} km but the domain stops at ${(domainTop / 1000).toFixed(1)} km — raise nz or dz to fit it.`
    );
  setStatus(parts.filter(Boolean).join(" "), "good");
}

$("toideal").addEventListener("click", () => {
  cfg.sounding.mode = "analytic";
  cfg.sounding.easy = true;
  cfg.sounding.windMode = "linear";
  rebuildPanel();
  send({ type: "config", cfg, rebuild: true });
  setStatus("Back to the idealised profile.", "");
});


// --- device profile --------------------------------------------------------
const deviceSel = $<HTMLSelectElement>("device");
let activeDevice: "desktop" | "mobile" | null = null;

function detectMobile(): boolean {
  const narrow = window.matchMedia("(max-width: 820px)").matches;
  const coarseAndSmall =
    window.matchMedia("(pointer: coarse)").matches &&
    window.matchMedia("(max-width: 1100px)").matches;
  return narrow || coarseAndSmall;
}

function effectiveDevice(): "desktop" | "mobile" {
  return cfg.ui.device === "auto"
    ? detectMobile()
      ? "mobile"
      : "desktop"
    : cfg.ui.device;
}

/**
 * Settings each device can actually keep up with. Ray marching costs a shader
 * run per pixel per sample and the solver costs a pass per cell, so a phone
 * gets a smaller domain, fewer samples and a capped pixel ratio rather than a
 * slide show.
 */
function profileFor(dev: "desktop" | "mobile"): Partial<Config> {
  return dev === "mobile"
    ? {
        grid: { nx: 32, ny: 32, nz: 32, dx: 800, dy: 800, dz: 500 },
        render: { ...cfg.render, steps: 72 },
      }
    : {
        grid: { nx: 48, ny: 48, nz: 40, dx: 600, dy: 600, dz: 400 },
        render: { ...cfg.render, steps: 160 },
      };
}

function applyDevice(dev: "desktop" | "mobile", retune: boolean): void {
  const changed = activeDevice !== dev;
  activeDevice = dev;
  document.body.dataset.device = dev;
  view.setPixelRatioCap(dev === "mobile" ? 1.25 : 2);
  map.hint =
    dev === "mobile"
      ? "tap to pick · pinch to zoom · drag to pan"
      : "click to pick · scroll to zoom · drag to pan";
  map.draw();

  if (retune && changed) {
    const prof = profileFor(dev);
    Object.assign(cfg.grid, prof.grid);
    cfg.render.steps = prof.render!.steps;
    rebuildPanel();
    view.setGrid(cfg.grid, cfg.render.exaggerateZ);
    view.applyRenderConfig(cfg.render);
    send({ type: "config", cfg, rebuild: true });
  }
  view.resize();
  view.frameDomain();
}

deviceSel.value = cfg.ui.device;
deviceSel.addEventListener("change", () => {
  cfg.ui.device = deviceSel.value as Config["ui"]["device"];
  applyDevice(effectiveDevice(), true);
});

// --- mobile tab bar --------------------------------------------------------
const tabButtons = Array.from(
  document.querySelectorAll("#tabs button")
) as HTMLButtonElement[];
function setTab(name: string): void {
  document.body.dataset.tab = name;
  for (const b of tabButtons) b.classList.toggle("on", b.dataset.tab === name);
  // The canvas was hidden while another tab was up, so its size is stale.
  requestAnimationFrame(() => view.resize());
}
for (const b of tabButtons)
  b.addEventListener("click", () => setTab(b.dataset.tab ?? "view"));
setTab("view");

// Only downgrade automatically; a shared link keeps the settings it carries.
applyDevice(effectiveDevice(), !sharedLink && effectiveDevice() === "mobile");

window.addEventListener("resize", () => {
  if (cfg.ui.device === "auto") applyDevice(effectiveDevice(), true);
});

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
  if (!cfg.ui.expert) {
    const gust = Math.abs(diag.minW);
    h.textContent = [
      `elapsed     ${String(mm).padStart(3)}:${String(ss).padStart(2, "0")}`,
      `updraft     ${diag.maxW.toFixed(0)} m/s   downdraft ${gust.toFixed(0)} m/s`,
      `cloud top   ${(diag.cloudTop / 1000).toFixed(1)} km`,
      `rain so far ${diag.maxRainAccum.toFixed(0)} mm`,
      `running at  ${(cfg.numerics.dt / (msPerStep / 1000)).toFixed(0)}x real time`,
    ].join("\n");
    if (!diag.stable)
      showWarn("The run blew up. Press Reset, and lower the cell size or CAPE.");
    else hideWarn();
    return;
  }
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

  if (!cfg.ui.expert) {
    const verdict =
      b.cape < 300
        ? "little to work with"
        : b.cape < 1200
        ? "weak storms"
        : b.cape < 2500
        ? "ordinary thunderstorms"
        : b.cape < 4000
        ? "strong storms"
        : "extreme instability";
    const org =
      b.shear6 < 10
        ? "too little shear to organise — expect a short-lived pulse"
        : b.shear6 < 20
        ? "enough shear for multicells"
        : "supercell shear";
    $("indices").textContent = [
      `fuel (CAPE)   ${g(b.cape, 0)} J/kg — ${verdict}`,
      `cap (CIN)     ${g(b.cin, 0)} J/kg`,
      `cloud base    ${g(b.lclZ, 0)} m`,
      `storm top     ${g(b.elZ, 0)} m`,
      `shear 0-6 km  ${g(b.shear6, 1)} m/s — ${org}`,
      `water column  ${g(b.pwat, 1)} mm`,
    ].join("\n");
    return;
  }

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
