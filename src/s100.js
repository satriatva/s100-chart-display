/* ============================================================
   S-100 CHART DISPLAY (SuperMap iServer 2026 + iClient Leaflet 12.1.x)
   Web viewer for IHO S-100 products, grown out of an earlier S-57 / S-52 viewer:
     S-101 ENC · S-102 bathymetry · S-104 water level · S-98 interoperability
   All service URLs / dataset names live in s100.config.js
============================================================ */
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "@supermapgis/iclient-leaflet";
import { CONFIG } from "./s100.config.js";

const $ = (id) => document.getElementById(id);
const MAP_URL = CONFIG.MAP_URL.split("?")[0];
const DATA_URL = CONFIG.DATA_URL;

const chartService = new L.supermap.ChartService(MAP_URL, DATA_URL, { parseProperties: true });

/* ============================================================
   UI HELPERS – storage, toasts, busy indicator
============================================================ */
// localStorage can be blocked (private window, kiosk policy): never let it break the app
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(`s100.${k}`); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`s100.${k}`, String(v)); } catch { /* ignore */ } }
};

function toast(msg, kind = "info", ms = 6000, pin = false) {
  const host = $("toastHost");
  // do not stack the same message twice
  if ([...host.children].some((t) => t.dataset.msg === msg)) return;
  // keep the map visible: at most 3 toasts, the oldest unpinned one goes first
  while (host.children.length >= 3) {
    const old = [...host.children].find((t) => !t.dataset.pin);
    if (!old) break;
    old.remove();
  }
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.dataset.msg = msg;
  if (pin) el.dataset.pin = "1";
  el.innerHTML = `<span class="toast-msg"></span><button type="button" aria-label="Close">✕</button>`;
  el.querySelector(".toast-msg").textContent = msg;
  el.querySelector("button").onclick = () => el.remove();
  host.append(el);
  if (ms) setTimeout(() => el.remove(), ms);
}

const busyJobs = new Map();
let busySeq = 0;
function busy(label) {
  const id = ++busySeq;
  busyJobs.set(id, label);
  renderBusy();
  return () => { busyJobs.delete(id); renderBusy(); };
}
function renderBusy() {
  const labels = [...busyJobs.values()];
  $("statusBusy").classList.toggle("hidden", !labels.length);
  $("statusBusyText").textContent = labels.length ? labels[labels.length - 1] + (labels.length > 1 ? ` (+${labels.length - 1})` : "") : "";
}
async function track(label, fn) {
  const end = busy(label);
  try { return await fn(); } finally { end(); }
}

/* Display theme DAY / DUSK / NIGHT – drives the UI palette AND the chart colour scheme */
const THEMES = ["day", "dusk", "night"];
const S100_SCHEME = { day: "DAY", dusk: "DUSK", night: "NIGHT" };
const S57_SCHEME = { day: "DAY_BRIGHT", dusk: "DUSK", night: "NIGHT" };
let theme = THEMES.includes(store.get("theme")) ? store.get("theme") : "day";
document.body.dataset.theme = theme;

// overlay colours (identify / measure graphics) per theme – dim at night
const OVERLAY = {
  day: { hi: "#dc2626", dist: "#f97316", area: "#10b981", pick: "#2563eb" },
  dusk: { hi: "#e5484d", dist: "#e8893a", area: "#34b27d", pick: "#5b8def" },
  night: { hi: "#7a2a1e", dist: "#7a4a1a", area: "#3f5a2a", pick: "#5a4630" }
};
const ov = (k) => OVERLAY[theme][k];

/* ============================================================
   MAP
============================================================ */
// Leaflet's keyboard handler treats keyCode 54 ("6") as zoom-out; "6" is our Measure shortcut.
// Keep "-" / numpad "-" for zoom-out. (Must be set before the map is created.)
L.Map.Keyboard.prototype.keyCodes = {
  ...L.Map.Keyboard.prototype.keyCodes,
  zoomOut: L.Map.Keyboard.prototype.keyCodes.zoomOut.filter((k) => k !== 54)
};
const map = L.map("map", {
  preferCanvas: true,
  crs: L.CRS.EPSG3857,
  center: CONFIG.CENTER,
  zoom: CONFIG.ZOOM,
  maxZoom: 22,
  zoomControl: false
});
L.control.zoom({ position: "topleft" }).addTo(map);

// Scale bar in nautical miles and kilometres (navigators read NM first)
const NmScale = L.Control.extend({
  options: { position: "topleft", maxWidth: 120 },
  onAdd(m) {
    this._div = L.DomUtil.create("div", "nm-scale");
    m.on("zoomend moveend", this._update, this);
    setTimeout(() => this._update());
    return this._div;
  },
  onRemove(m) { m.off("zoomend moveend", this._update, this); },
  _nice(v) {
    const p = Math.pow(10, Math.floor(Math.log10(v))), d = v / p;
    return p * (d >= 5 ? 5 : d >= 2 ? 2 : 1);
  },
  _update() {
    const m = this._map, y = m.getSize().y / 2;
    const metres = m.containerPointToLatLng([0, y]).distanceTo(m.containerPointToLatLng([this.options.maxWidth, y]));
    if (!metres) return;
    const nm = this._nice(metres / 1852), km = this._nice(metres / 1000);
    const w = (v, unit) => Math.round((this.options.maxWidth * v * unit) / metres);
    this._div.innerHTML =
      `<div>${nm} NM</div><div class="bar" style="width:${w(nm, 1852)}px"></div>` +
      `<div class="bar" style="width:${w(km, 1000)}px"></div><div>${km} km</div>`;
  }
});
// "Zoom to chart extent" button directly under +/− (and the "Back" chip after a zoom)
const EXT_SVG = '<svg class="ext-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>';
const ExtentControl = L.Control.extend({
  options: { position: "topleft" },
  onAdd() {
    const wrap = L.DomUtil.create("div", "extent-ctl");
    wrap.innerHTML =
      `<div class="leaflet-bar"><a href="#" id="btnZoomExtent" role="button" aria-label="Zoom to chart extent">${EXT_SVG}</a></div>` +
      `<button id="btnExtentBack" class="back-chip hidden" type="button" data-tooltip="Return to the previous view">↶ Back</button>`;
    L.DomEvent.disableClickPropagation(wrap); // never pins the probe / hits a map tool
    L.DomEvent.disableScrollPropagation(wrap);
    return wrap;
  }
});
new ExtentControl().addTo(map);
new NmScale().addTo(map);

/* S-57 ENC base chart (separate map, S-52 portrayal) – optional */
const encSetting = () =>
  new L.supermap.ChartSettingS57({ displayModeChart: "STANDARD", colourModeChart: S57_SCHEME[theme] });
const encLayer = CONFIG.ENC_MAP_URL
  ? new L.supermap.TiledMapLayer(CONFIG.ENC_MAP_URL.split("?")[0], {
      prjCoordSys: { epsgCode: 3857 },
      transparent: true,
      chartSetting: encSetting()
    }).addTo(map)
  : null;
encLayer && encLayer.setZIndex(400);

/* S-100 chart (S-101 / S-102 / S-104) on top */
const chartLayer = new L.supermap.TiledMapLayer(MAP_URL, {
  prjCoordSys: { epsgCode: 3857 },
  transparent: true
}).addTo(map);
chartLayer.setZIndex(500);

/* ============================================================
   STATE
============================================================ */
let currentMode = "default";
let defaultChartSetting = null; // chartSetting stored in the published map
let pcInfo = null;              // portrayal-catalogue parameters per PC version
let subLayers = [];
let visibleLayerIdx = [];
const wla = { enabled: false, times: [], idx: 0, timer: null };
const probe = { on: false, pinned: null, marker: null }; // S-102 depth probe (hover + pin)
let probeLinkLayer = null; // S-104 source link of the pinned reading (created with the map)

let sqlResultLayer = null;
let tideStationLayer = null;

const imgSrc = {
  Point: "./img/point1.png", MultiPoint: "./img/point1.png",
  LineString: "./img/line.png", MultiLineString: "./img/line.png",
  Polygon: "./img/polygon.png", MultiPolygon: "./img/polygon.png"
};

/* ============================================================
   MODE CONTROLLER (one map-click tool at a time)
============================================================ */
const TOOL_LABEL = {
  "identify-point": "IDENTIFY – POINT · click the chart",
  "identify-area": "IDENTIFY – AREA · drag a box",
  tide: "TIDE – click near an S-104 grid point",
  "measure-distance": "DISTANCE – click points, double-click to finish",
  "measure-area": "AREA – click points, double-click to finish",
  "measure-coord": "POSITION – move or click the chart"
};
const QUERY_HINT = "Choose Point (click a location) or Area (hold and drag a box on the chart).";

// the chip lists every active tool: the depth probe runs next to the click tools
function updateToolChip() {
  const parts = [];
  if (probe.on) parts.push(probe.pinned ? "DEPTH PROBE – PINNED" : "DEPTH PROBE (hover · click to pin)");
  if (TOOL_LABEL[currentMode]) parts.push(TOOL_LABEL[currentMode]);
  $("toolChip").classList.toggle("hidden", !parts.length);
  $("toolChipText").textContent = parts.length ? `${parts.join("  +  ")} · Esc to cancel` : "";
  map.getContainer().style.cursor = currentMode !== "default" || probe.on ? "crosshair" : "";
}

// Esc / ✕ on the chip: click tool first, then the pin, then the probe itself
function cancelTool() {
  const m = currentMode;
  if (m !== "default") {
    setMode("default");
    if (m.startsWith("identify")) $("queryTips").textContent = QUERY_HINT;
    if (m.startsWith("measure")) $("measureResult").textContent = MEASURE_HINT;
    return;
  }
  if (probe.pinned) return releasePin();
  if (probe.on) setProbe(false);
}

function setMode(mode) {
  currentMode = mode;
  updateToolChip();
  map.off("click", onIdentifyClick);
  map.off("mousedown", onBoxDown);
  map.off("mousemove", onBoxMove);
  map.off("mouseup", onBoxUp);
  map.dragging.enable();
  document.querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("active"));
  map.off("click", onTideClick);
  map.off("click", onMeasureClick);
  map.off("dblclick", onMeasureDbl);
  map.off("mousemove", onMeasureMove);
  map.off("mousemove", onCoordMove);
  map.off("click", onCoordClick);
  map.doubleClickZoom.enable();

  if (mode === "identify-point") map.on("click", onIdentifyClick);
  if (mode === "identify-area") {
    map.dragging.disable(); // left-drag draws the query box instead of panning
    map.on("mousedown", onBoxDown);
    map.on("mousemove", onBoxMove);
    map.on("mouseup", onBoxUp);
  }
  if (mode === "tide") map.on("click", onTideClick);
  $("btnTideOn").classList.toggle("active", mode === "tide");
  if (mode === "measure-distance" || mode === "measure-area") {
    map.doubleClickZoom.disable();
    map.on("click", onMeasureClick);
    map.on("dblclick", onMeasureDbl);
    map.on("mousemove", onMeasureMove);
  }
  if (!mode.startsWith("measure")) resetMeasureTool();
  if (mode === "measure-coord") {
    map.on("mousemove", onCoordMove);
    map.on("click", onCoordClick);
  }
}

/* ============================================================
   1. S-100 DISPLAY SETTINGS (portrayal catalogue + S-98)
============================================================ */
async function initS100Settings() {
  const end = busy("Reading portrayal catalogue…");
  try {
    const mapInfo = await new L.supermap.MapService(MAP_URL).getMapInfo();
    if (!mapInfo?.result) throw mapInfo?.error || new Error("getMapInfo failed");
    defaultChartSetting = mapInfo.result.chartSetting || null;
    const pc = await chartService.getChartMaritimePcInfo();
    pcInfo = pc?.result || {};
    buildPcPanel();
    buildBasicPanel();
    buildLegend();
    // bring the chart in line with the saved theme (DAY is the published default)
    if (theme !== "day") applyChartSetting();
  } catch (err) {
    console.error(err);
    const msg = "Could not read the portrayal catalogue. Check MAP_URL and that the Chart service module is licensed.";
    $("pcPanel").innerHTML = `<p class="hint text-red-600">${msg}</p>`;
    $("basicParams").innerHTML = `<p class="hint text-red-600 span-2">${msg}</p>`;
    toast(msg, "error", 0);
  } finally {
    end();
  }
}

// Basic section: the parameters a navigator changes most, moved out of the PC groups
// (the same DOM controls are moved, so buildChartSetting() keeps reading them by id)
const BASIC_PARAMS = ["DisplayMode", "SafetyContour", "ShallowContour", "DeepContour", "SafetyDepth", "FourShades"];
function buildBasicPanel() {
  const box = $("basicParams");
  box.innerHTML = "";
  const types = Object.keys(defaultChartSetting?.contextParameters || {}).filter(
    (t) => defaultChartSetting.contextParameters[t]?.PCVersion
  );
  types.forEach((type) => {
    const version = defaultChartSetting.contextParameters[type].PCVersion;
    const params = pcInfo[version] || [];
    BASIC_PARAMS.forEach((id) => {
      const p = params.find((x) => x.id === id);
      const el = p && $(pcDomId(type, id));
      if (!el) return;
      const cell = el.parentElement;
      cell.querySelector("label").textContent = `${type.replace(/^S/, "S-")} · ${p.name || p.id}`;
      el.addEventListener("change", buildLegend);
      box.append(cell);
    });
  });
  if (!box.children.length) box.innerHTML = `<p class="hint span-2">No S-101 / S-102 parameters in this map – see Advanced.</p>`;
  // colour scheme is driven by the theme selector: lock those controls
  document.querySelectorAll("#pcPanel select[id$='_ColorScheme'], #pcPanel input[id$='_ColorScheme']").forEach((el) => {
    el.disabled = true;
    el.title = "Follows the DAY / DUSK / NIGHT selector";
  });
  syncSchemeControls();
}

// pick the portrayal-catalogue enum value matching the theme (DAY / DUSK / NIGHT)
function schemeValue(type) {
  const want = S100_SCHEME[theme];
  const version = defaultChartSetting?.contextParameters?.[type]?.PCVersion;
  const p = (pcInfo?.[version] || []).find((x) => x.id === "ColorScheme");
  const ids = (p?.contextParameterEnums || []).map((o) => String(o.id));
  return ids.find((v) => v.toUpperCase() === want) || ids.find((v) => v.toUpperCase().startsWith(want)) || want;
}
function syncSchemeControls() {
  Object.keys(defaultChartSetting?.contextParameters || {}).forEach((type) => {
    const el = $(pcDomId(type, "ColorScheme"));
    if (el) el.value = schemeValue(type);
  });
}

function pcDomId(type, id) {
  return `pc_${type}_${id}`.replace(/[^A-Za-z0-9_]/g, "_");
}

function buildPcPanel() {
  const panel = $("pcPanel");
  const types = Object.keys(defaultChartSetting?.contextParameters || {}).filter(
    (t) => defaultChartSetting.contextParameters[t]?.PCVersion
  );
  if (!types.length) {
    panel.innerHTML = `<p class="hint text-red-600">The published map returns an S-57 chartSetting (chartType: "${defaultChartSetting?.chartType || "?"}"),
      so there are no S-100 portrayal parameters. Put S-57 cells in a separate map (ENC_MAP_URL) and keep only S-100 data in MAP_URL.</p>`;
    return;
  }
  panel.innerHTML = "";
  types.forEach((type) => {
    const version = defaultChartSetting.contextParameters[type].PCVersion;
    const params = [...(pcInfo[version] || [])].sort((a, b) => String(a.type).localeCompare(String(b.type)));

    const box = document.createElement("details");
    box.className = "card pc-group";
    box.open = true;
    box.innerHTML = `<summary>${type} <span class="hint">(${version || "PC"})</span></summary>`;
    const grid = document.createElement("div");
    grid.className = "pc-grid";

    params.forEach((p) => {
      const id = pcDomId(type, p.id);
      const current = defaultChartSetting.contextParameters[type][p.id] ?? p.defaultValue;
      let control;
      if (p.contextParameterEnums || p.type === "Boolean") {
        const opts = p.contextParameterEnums
          ? p.contextParameterEnums.map((o) => ({ v: o.id, t: o.description || o.id }))
          : [{ v: "TRUE", t: "TRUE" }, { v: "FALSE", t: "FALSE" }];
        control = `<select id="${id}" class="input">${opts
          .map((o) => `<option value="${o.v}" ${String(current).toUpperCase() === String(o.v).toUpperCase() ? "selected" : ""}>${o.t}</option>`)
          .join("")}</select>`;
      } else if (p.type === "Double" || p.type === "Integer") {
        control = `<input id="${id}" type="number" step="any" value="${current ?? ""}" class="input" />`;
      } else {
        control = `<input id="${id}" value="${current ?? ""}" class="input" />`;
      }
      const cell = document.createElement("div");
      cell.innerHTML = `<label class="label" title="${p.id}">${p.name || p.id}</label>${control}`;
      grid.append(cell);
    });
    box.append(grid);
    panel.append(box);
  });
}

function readParam(domId, type) {
  const el = $(domId);
  if (!el || el.value === "") return undefined;
  if (type === "Double") return parseFloat(el.value);
  if (type === "Integer") return parseInt(el.value, 10);
  if (type === "Boolean") return el.value.toUpperCase() === "TRUE";
  return el.value;
}

function buildChartSetting() {
  const s98 = $("s98InteroperableEnable").value === "true";
  const wlaTime = wla.enabled ? wla.times[wla.idx] || "" : "";

  // Start from the defaults stored in the published map (keeps PCVersion etc.), then apply UI values
  const contextParameters = {};
  Object.entries(defaultChartSetting?.contextParameters || {}).forEach(([type, defaults]) => {
    contextParameters[type] = { ...defaults };
    const version = defaults.PCVersion;
    if (version) {
      (pcInfo?.[version] || []).forEach((p) => {
        const v = readParam(pcDomId(type, p.id), p.type);
        if (v !== undefined) contextParameters[type][p.id] = v;
      });
    }
  });
  // colour scheme of every product follows the DAY / DUSK / NIGHT theme
  Object.keys(contextParameters).forEach((type) => {
    if ("ColorScheme" in contextParameters[type] || contextParameters[type].PCVersion) {
      contextParameters[type].ColorScheme = schemeValue(type);
    }
  });
  // S98 block (iServer 2026) carries interoperability + WLA state – keep it consistent with the UI
  if (contextParameters.S98) {
    Object.assign(contextParameters.S98, {
      InteroperabilityLevel: s98 ? "1" : "0",
      WLAEnable: wla.enabled ? "TRUE" : "FALSE",
      WLATime: wlaTime
    });
  }

  // S-98: interoperable=true requires level 1, false requires level 0 (iClient API rule)
  return new L.supermap.ChartSettingS100({
    contextParameters,
    s98InteroperableEnable: s98,
    interoperabilityLevel: s98 ? 1 : 0,
    wlaEnable: wla.enabled,
    wlaDatetime: wlaTime || null
  });
}

function applyChartSetting() {
  // before the published defaults are known an empty setting would wipe the portrayal
  if (!defaultChartSetting) return false;
  chartLayer.updateParams({ chartSetting: buildChartSetting() });
  return true;
}

$("s98InteroperableEnable").onchange = (e) => {
  $("interoperabilityLevel").value = e.target.value === "true" ? "1" : "0";
};
$("interoperabilityLevel").onchange = (e) => {
  $("s98InteroperableEnable").value = e.target.value === "1" ? "true" : "false";
};
$("btnApplySettings").onclick = () => {
  if (applyChartSetting()) {
    buildLegend();
    toast("Display settings applied.", "ok", 2500);
  } else {
    toast("Portrayal parameters are not loaded yet – check the iServer connection.", "warn");
  }
};

function setTheme(t) {
  if (!THEMES.includes(t)) return;
  theme = t;
  document.body.dataset.theme = t;
  store.set("theme", t);
  document.querySelectorAll(".theme-btn").forEach((b) => b.classList.toggle("active", b.dataset.themeValue === t));
  syncSchemeControls();
  applyChartSetting();
  if (encLayer) encLayer.updateParams({ chartSetting: encSetting() });
  if (tideSeries.length) drawTideChart();
  buildLegend(); // legend note + overlay colours follow the theme
}
document.querySelectorAll(".theme-btn").forEach((b) => (b.onclick = () => setTheme(b.dataset.themeValue)));

/* ============================================================
   2. S-104 WATER LEVEL ADJUSTMENT (time slider + playback)
============================================================ */
// Time display: "20 Dec 2025 05:00Z" or military DTG "200500Z DEC 25" (header toggle)
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
let timeFmt = store.get("timefmt") === "dtg" ? "dtg" : "utc";
function parseTP(tp) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/.exec(tp || "");
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])) : null;
}
const p2 = (n) => String(n).padStart(2, "0");
function fmtDate(d, fmt = timeFmt, suffix = "Z", useUTC = true) {
  const D = useUTC ? d.getUTCDate() : d.getDate(), M = useUTC ? d.getUTCMonth() : d.getMonth();
  const Y = useUTC ? d.getUTCFullYear() : d.getFullYear(), h = useUTC ? d.getUTCHours() : d.getHours();
  const mi = useUTC ? d.getUTCMinutes() : d.getMinutes();
  return fmt === "dtg"
    ? `${p2(D)}${p2(h)}${p2(mi)}${suffix} ${MONTHS[M].toUpperCase()} ${String(Y).slice(2)}`
    : `${p2(D)} ${MONTHS[M]} ${Y} ${p2(h)}:${p2(mi)}${suffix}`;
}
function fmtTime(tp) {
  const d = parseTP(tp);
  return d ? fmtDate(d) : tp || "–";
}
// local time in WIB (UTC+7) for the WLA panel
function fmtWib(tp) {
  const d = parseTP(tp);
  if (!d) return "";
  const w = new Date(d.getTime() + 7 * 3600e3);
  return `${fmtDate(w, "utc", "", true)} WIB (UTC+7)`;
}
function renderWlaTime(extra = "") {
  const tp = wla.times[wla.idx];
  $("wlaCurrent").textContent = tp ? fmtTime(tp) + extra : "–";
  $("wlaLocal").textContent = tp ? fmtWib(tp) : "";
  setStatus("statusWla", wla.enabled && tp ? `WLA ${fmtTime(tp)}` : "");
}
function setTimeFmt(f) {
  timeFmt = f === "dtg" ? "dtg" : "utc";
  store.set("timefmt", timeFmt);
  document.querySelectorAll(".time-btn").forEach((b) => b.classList.toggle("active", b.dataset.timeValue === timeFmt));
  clockTick();
  if (wla.times.length) {
    $("wlaStart").textContent = fmtTime(wla.times[0]);
    $("wlaEnd").textContent = fmtTime(wla.times[wla.times.length - 1]);
    renderWlaTime();
  }
}
document.querySelectorAll(".time-btn").forEach((b) => (b.onclick = () => setTimeFmt(b.dataset.timeValue)));

async function initWlaTimes() {
  const end = busy("Reading S-104 time range…");
  try {
    const res = await chartService.getWLTimeRange(
      new L.supermap.ChartWLTimeRangeParameter({
        dataSource: CONFIG.S104_DATASOURCE,
        dataset: CONFIG.S104_POSITION_DATASET,
        timeDataset: CONFIG.S104_TIME_DATASET,
        idKey: CONFIG.S104_CELL_ID_KEY
      })
    );
    const feats = res?.result?.features?.features || [];
    wla.times = [...new Set(feats.map((f) => f.properties.TIMEPOINT ?? f.properties.timePoint))].filter(Boolean).sort();
    if (!wla.times.length) throw new Error("No S-104 time points returned");
    const s = $("wlaSlider");
    s.max = wla.times.length - 1;
    s.value = 0;
    $("wlaStart").textContent = fmtTime(wla.times[0]);
    $("wlaEnd").textContent = fmtTime(wla.times[wla.times.length - 1]);
    renderWlaTime();
  } catch (err) {
    console.error("getWLTimeRange:", err);
    $("wlaCurrent").textContent = "S-104 time range not available";
    toast("S-104 time range not available – check the S104_* names in s100.config.js.", "error", 0);
  } finally {
    end();
  }
}

function setWlaIndex(i) {
  wla.idx = Math.max(0, Math.min(i, wla.times.length - 1));
  $("wlaSlider").value = wla.idx;
  renderWlaTime();
  if (wla.enabled) applyChartSetting();
  markTideCursor();
  refreshPinnedDepth();
}

function setWlaEnabled(on) {
  if (on && !wla.times.length) {
    toast("WLA needs the S-104 time range, which is not loaded.", "warn");
    on = false;
  }
  wla.enabled = on;
  $("wlaEnable").value = String(on);
  $("basicWla").value = String(on);
  ["wlaSlider", "btnWlaPlay", "btnWlaPause", "btnWlaLow", "btnWlaHigh"].forEach((id) => ($(id).disabled = !on));
  $("wlaControls").classList.toggle("is-disabled", !on);
  $("wlaControls").dataset.tooltip = on ? "" : "Turn WLA on first";
  if (!on) wlaPause();
  renderWlaTime();
  applyChartSetting();
  refreshPinnedDepth();
}
$("wlaEnable").onchange = (e) => setWlaEnabled(e.target.value === "true");
$("basicWla").onchange = (e) => setWlaEnabled(e.target.value === "true");
$("wlaSlider").oninput = (e) => {
  $("wlaCurrent").textContent = fmtTime(wla.times[+e.target.value]);
  $("wlaLocal").textContent = fmtWib(wla.times[+e.target.value]);
};
$("wlaSlider").onchange = (e) => setWlaIndex(+e.target.value);

function wlaPlay() {
  wlaPause();
  wla.timer = setInterval(() => {
    if (wla.idx >= wla.times.length - 1) return wlaPause();
    setWlaIndex(wla.idx + 1);
  }, CONFIG.WLA_PLAY_INTERVAL_MS);
}
function wlaPause() {
  if (wla.timer) clearInterval(wla.timer);
  wla.timer = null;
}
// jump to the lowest / highest water level of the reference point
// (last clicked tide station, otherwise the map centre)
let tideRefLatLng = null;
async function jumpToTide(kind) {
  wlaPause();
  $("wlaCurrent").textContent = "Finding " + kind + " tide…";
  const end = busy(`Finding ${kind} tide…`);
  try {
    const w = await readS104(tideRefLatLng || map.getCenter());
    if (!w || !w.series.length) {
      renderWlaTime();
      toast("No S-104 data at the map centre – use 'Select on Map' on a tide station first.", "warn");
      return;
    }
    const pick = w.series.reduce((a, b) => (kind === "lowest" ? (b.h < a.h ? b : a) : (b.h > a.h ? b : a)));
    const i = wla.times.indexOf(pick.t);
    if (i >= 0) setWlaIndex(i);
    renderWlaTime(` · ${kind} ${pick.h >= 0 ? "+" : ""}${pick.h.toFixed(2)} m`);
  } catch (err) {
    console.error(err);
    renderWlaTime();
    toast("S-104 water-level query failed.", "error");
  } finally {
    end();
  }
}
$("btnWlaLow").onclick = () => jumpToTide("lowest");
$("btnWlaHigh").onclick = () => jumpToTide("highest");
$("btnWlaPlay").onclick = wlaPlay;
$("btnWlaPause").onclick = wlaPause;

/* ============================================================
   3. S-104 TIDE CURVE AT A STATION
============================================================ */
let tideSeries = [];

async function onTideClick(e) {
  $("tidePanel").classList.remove("hidden");
  $("tideInfo").textContent = "Interpolating S-104 water level at the click…";
  $("tideChart").innerHTML = "";
  const end = busy("Reading S-104 water level…");
  try {
    tideRefLatLng = e.latlng;
    const w = await readS104(e.latlng);
    if (!w) {
      $("tideInfo").textContent = "No S-104 grid point within ~3 km of the click.";
      return;
    }
    if (!tideStationLayer) tideStationLayer = L.layerGroup().addTo(map);
    drawS104Link(tideStationLayer, w);
    if (!probe.on) {
      // mark the clicked point itself (the depth-probe pin does this when the probe is on)
      L.circleMarker(e.latlng, { radius: 4, color: ov("pick"), weight: 2, fillOpacity: 0.9, interactive: false }).addTo(tideStationLayer);
    }

    tideSeries = w.series;

    const hs = tideSeries.map((d) => d.h);
    $("tideInfo").textContent =
      `At ${fmtPos(e.latlng, "ddm")} · ${s104Source(w)} · ${tideSeries.length} time steps · ` +
      `min ${Math.min(...hs).toFixed(2)} m · max ${Math.max(...hs).toFixed(2)} m`;
    drawTideChart();
  } catch (err) {
    console.error("getWaterLevel:", err);
    $("tideInfo").textContent = "Water-level query failed.";
    toast("S-104 water-level query failed – check DATA_URL and the S104_* names.", "error");
  } finally {
    end();
  }
}

function drawTideChart() {
  const W = 420, H = 170, P = { l: 38, r: 8, t: 8, b: 26 };
  if (!tideSeries.length) return;
  const hs = tideSeries.map((d) => d.h);
  const min = Math.floor(Math.min(...hs) * 10) / 10, max = Math.ceil(Math.max(...hs) * 10) / 10 || 1;
  const x = (i) => P.l + (i / Math.max(1, tideSeries.length - 1)) * (W - P.l - P.r);
  const y = (h) => P.t + (1 - (h - min) / (max - min || 1)) * (H - P.t - P.b);
  const path = tideSeries.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d.h).toFixed(1)}`).join("");
  const ticks = [min, (min + max) / 2, max];
  let lastX = -1e9; // one label per day, never closer than 44 px
  const days = tideSeries
    .map((d, i) => ({ i, t: d.t }))
    .filter((d, k, arr) => k === 0 || d.t.slice(0, 8) !== arr[k - 1].t.slice(0, 8))
    .filter((d) => (x(d.i) - lastX >= 44 ? ((lastX = x(d.i)), true) : false));
  // colours come from the theme (CSS variables), so the curve is readable in DAY / DUSK / NIGHT
  $("tideChart").innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="100%" style="font:11px ui-monospace,Consolas,monospace">
      ${ticks.map((v) => `<line x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}" style="stroke:var(--border)"/>
        <text x="${P.l - 4}" y="${y(v) + 3}" text-anchor="end" style="fill:var(--muted)">${v.toFixed(1)}</text>`).join("")}
      ${days.map((d) => `<line x1="${x(d.i)}" x2="${x(d.i)}" y1="${P.t}" y2="${H - P.b}" style="stroke:var(--border);opacity:.6"/>
        <text x="${x(d.i) + 2}" y="${H - 10}" style="fill:var(--muted)">${d.t.slice(6, 8)} ${MONTHS[+d.t.slice(4, 6) - 1]}</text>`).join("")}
      <path d="${path}" fill="none" style="stroke:var(--title)" stroke-width="1.8"/>
      <line id="tideCursor" x1="0" x2="0" y1="${P.t}" y2="${H - P.b}" style="stroke:var(--accent)" stroke-width="2" visibility="hidden"/>
      <text x="4" y="${P.t + 8}" style="fill:var(--muted)">m</text>
    </svg>`;
  drawTideChart.x = x;
  markTideCursor();
}

function markTideCursor() {
  const c = document.getElementById("tideCursor");
  if (!c || !wla.enabled || !tideSeries.length) return c && c.setAttribute("visibility", "hidden");
  const i = tideSeries.findIndex((d) => d.t === wla.times[wla.idx]);
  if (i < 0) return c.setAttribute("visibility", "hidden");
  const xv = drawTideChart.x(i);
  c.setAttribute("x1", xv);
  c.setAttribute("x2", xv);
  c.setAttribute("visibility", "visible");
}

$("btnTideOn").onclick = () => setMode("tide");
$("btnTideOff").onclick = () => {
  setMode("default");
  $("tidePanel").classList.add("hidden");
  if (tideStationLayer) map.removeLayer(tideStationLayer);
  tideStationLayer = null;
};
$("btnTideClose").onclick = $("btnTideOff").onclick;

/* ============================================================
   4. S-102 DEPTH QUERY (mouse move)
============================================================ */
// lon/lat (WGS 84) -> UTM (WGS 84), standard Transverse Mercator series
function toUTM(lat, lon, zone, south) {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const rad = Math.PI / 180, lon0 = ((zone - 1) * 6 - 180 + 3) * rad;
  const phi = lat * rad, lam = lon * rad;
  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const T = Math.tan(phi) ** 2, C = ep2 * Math.cos(phi) ** 2, A = Math.cos(phi) * (lam - lon0);
  const M = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * phi
    - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * phi)
    + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * phi)
    - (35 * e2 ** 3 / 3072) * Math.sin(6 * phi));
  const x = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T ** 2 + 72 * C - 58 * ep2) * A ** 5 / 120) + 500000;
  let y = k0 * (M + N * Math.tan(phi) * (A ** 2 / 2 + (5 - T + 9 * C + 4 * C ** 2) * A ** 4 / 24
    + (61 - 58 * T + T ** 2 + 600 * C - 330 * ep2) * A ** 6 / 720));
  if (south) y += 10000000;
  return { x, y };
}

function toS102XY(latlng) {
  const c = CONFIG.S102_CRS;
  if (c.type === "utm") {
    const p = toUTM(latlng.lat, latlng.lng, c.zone, c.south);
    return { X: p.x, Y: p.y };
  }
  return { X: latlng.lng, Y: latlng.lat };
}

/* ---------- depth probe: independent of the click tools ----------
   hover  = live reading under the cursor
   click  = pin (hold) the reading; hover then only updates the status bar
   It runs together with the S-104 tide tool: one click pins the depth AND loads the tide curve. */
// Vessel draft and required under-keel clearance (remembered per browser)
const numOr = (v, d) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : d);
$("vesselDraft").value = numOr(store.get("draft"), numOr(CONFIG.VESSEL_DRAFT_M, 5.0));
$("ukcMargin").value = numOr(store.get("ukcMargin"), numOr(CONFIG.UKC_MARGIN_M, 1.0));
$("vesselDraft").onchange = (e) => store.set("draft", e.target.value);
$("ukcMargin").onchange = (e) => store.set("ukcMargin", e.target.value);

function showUkc(waterDepth, tideApplied) {
  const badge = $("ukcBadge");
  const draft = numOr($("vesselDraft").value, NaN);
  if (waterDepth === null || !Number.isFinite(draft)) { badge.classList.add("hidden"); return ""; }
  const margin = numOr($("ukcMargin").value, 0);
  const ukc = waterDepth - draft;
  const [cls, word] = ukc < 0 ? ["nogo", "NO-GO"] : ukc < margin ? ["caution", "CAUTION"] : ["ok", "OK"];
  badge.className = `ukc-badge ${cls}`;
  badge.textContent = `UKC ${ukc >= 0 ? "+" : ""}${ukc.toFixed(2)} m · ${word}` + (tideApplied ? "" : " · no tide (WLA off)");
  showUkc.last = { ukc, cls, word, draft, margin, tideApplied };
  return `UKC ${ukc >= 0 ? "+" : ""}${ukc.toFixed(1)} ${word}`;
}

function setDepthIdle() {
  $("depthResult").textContent = probe.on ? "Hover the chart – click to pin a reading." : "–";
  $("depthResult").classList.remove("pinned");
  $("ukcBadge").classList.add("hidden");
  setStatus("statusDepth", "");
}

// read S-102 depth (+ S-104 water level when WLA is on) at a point
async function readDepthAt(latlng) {
  const c = await readS102(latlng);
  if (!c) return null;
  let text =
    `Charted depth (S-102): ${c.depth.toFixed(2)} m\n` +
    (c.uncertainty !== null ? `Uncertainty: ±${c.uncertainty.toFixed(2)} m\n` : "");
  let status = `Depth ${c.depth.toFixed(1)} m`;
  let water = c.depth, tideApplied = false;
  let s104 = null;
  if (wla.enabled) {
    const t = wla.times[wla.idx];
    const r = await waterLevelAt(latlng, t).catch(() => null);
    if (r) {
      const h = r.h;
      s104 = r.w;
      water = c.depth + h;
      tideApplied = true;
      text += `Water level (S-104) @ ${fmtTime(t)}: ${h >= 0 ? "+" : ""}${h.toFixed(2)} m\n` +
              `  ${s104Source(r.w)}\n` +
              `Actual water depth: ${water.toFixed(2)} m\n`;
      status += ` · actual ${water.toFixed(1)} m`;
    }
  }
  return { text, status, water, tideApplied, s104 };
}

let depthErrorShown = 0;
const depthSeq = { hover: 0, pin: 0 }; // drop answers that arrive after a newer request
async function queryDepth(latlng, target = "hover") {
  const seq = ++depthSeq[target];
  try {
    const r = await readDepthAt(latlng);
    if (!probe.on || seq !== depthSeq[target]) return;
    if (target === "hover" && probe.pinned) {
      // pinned: the result box keeps the pinned reading, the status bar follows the cursor
      setStatus("statusDepth", r ? `${r.status} (cursor)` : "Depth – (cursor)");
      return;
    }
    const box = $("depthResult");
    box.classList.toggle("pinned", target === "pin");
    const head = target === "pin" ? `PINNED  ${fmtPos(latlng, "ddm")}\n` : "";
    if (!r) {
      if (target === "pin") { probe.result = { latlng, r: null }; probe.marker?.unbindTooltip(); }
      box.textContent = `${head}No S-102 coverage here` + (head ? "" : `\n${fmtPos(latlng, "ddm")}`);
      $("ukcBadge").classList.add("hidden");
      setStatus("statusDepth", "Depth –");
      return;
    }
    const ukc = showUkc(r.water, r.tideApplied);
    box.textContent = head + r.text + (head ? "" : fmtPos(latlng, "ddm"));
    if (target === "pin") {
      // keep the pinned result for printing and label the pin on the chart (also visible in print)
      probe.result = { latlng, r, u: showUkc.last, wlaTime: r.tideApplied ? wla.times[wla.idx] : null };
      const u = showUkc.last;
      if (probe.marker && u) {
        probe.marker.unbindTooltip();
        probe.marker.bindTooltip(`UKC ${u.ukc >= 0 ? "+" : ""}${u.ukc.toFixed(2)} m · ${u.word}`, {
          permanent: true, direction: "right", offset: [10, 0], className: `measure-label ukc-tip ${u.cls}`
        });
      }
    }
    // pinned with WLA on: show where the S-104 value comes from (the tide tool draws its own link)
    probeLinkLayer.clearLayers();
    if (target === "pin" && r.s104 && currentMode !== "tide") drawS104Link(probeLinkLayer, r.s104);
    setStatus("statusDepth", (ukc ? `${r.status} · ${ukc}` : r.status) + (target === "pin" ? " · PINNED" : ""));
  } catch (err) {
    console.error("S-102 depth:", err);
    if (target === "pin" || !probe.pinned) $("depthResult").textContent = "Depth query failed.";
    if (Date.now() - depthErrorShown > 60000) { // one toast per minute while the cursor keeps moving
      depthErrorShown = Date.now();
      toast("S-102 depth query failed – check DATA_URL and S102_CRS.", "error");
    }
  }
}

let depthTimer = null;
function onProbeMove(e) {
  if (!probe.on) return;
  clearTimeout(depthTimer);
  depthTimer = setTimeout(() => queryDepth(e.latlng, "hover"), 150);
}
function onProbeClick(e) {
  // Identify and Measure own the map click; Tide shares it with the probe
  if (!probe.on || currentMode.startsWith("identify") || currentMode.startsWith("measure")) return;
  pinDepth(e.latlng);
}
function pinDepth(latlng) {
  probe.pinned = latlng;
  if (!probe.marker) {
    probe.marker = L.circleMarker(latlng, {
      radius: 7, weight: 3, color: getComputedStyle(document.body).getPropertyValue("--accent").trim() || "#c9a227",
      fillColor: theme === "night" ? "#000000" : "#ffffff", fillOpacity: 0.9, interactive: false
    }).addTo(map);
  } else {
    probe.marker.setLatLng(latlng);
  }
  $("btnDepthRelease").disabled = false;
  updateToolChip();
  queryDepth(latlng, "pin");
}
function releasePin() {
  probe.pinned = null;
  probe.result = null;
  probeLinkLayer.clearLayers();
  if (probe.marker) map.removeLayer(probe.marker);
  probe.marker = null;
  $("btnDepthRelease").disabled = true;
  depthSeq.pin++;
  setDepthIdle();
  updateToolChip();
}
function refreshPinnedDepth() {
  if (probe.on && probe.pinned) queryDepth(probe.pinned, "pin");
}
function setProbe(on) {
  probe.on = on;
  $("btnDepthOn").classList.toggle("active", on);
  $("btnDepthOn").querySelector("span").textContent = on ? "Probe running" : "Start probe";
  if (!on) releasePin();
  setDepthIdle();
  updateToolChip();
}
probeLinkLayer = L.layerGroup().addTo(map);
map.on("mousemove", onProbeMove);
map.on("click", onProbeClick);

$("btnDepthOn").onclick = () => setProbe(!probe.on); // click again to stop, like the other toggles
$("btnDepthOff").onclick = () => setProbe(false);
$("btnDepthRelease").onclick = releasePin;
$("vesselDraft").addEventListener("change", refreshPinnedDepth);
$("ukcMargin").addEventListener("change", refreshPinnedDepth);

function setStatus(id, text) {
  $(id).textContent = text; // empty items are hidden by CSS (.sb-item:empty)
}

/* ============================================================
   5. QUERY SOURCES – every chart map shown in the app
      (S-100 map + the optional S-57 ENC map)
============================================================ */
const sources = [
  { key: "S100", label: "S-100", url: MAP_URL, service: chartService, layers: [], infos: [] }
];
if (CONFIG.ENC_MAP_URL) {
  const encUrl = CONFIG.ENC_MAP_URL.split("?")[0];
  sources.push({
    key: "ENC", label: "ENC S-57", url: encUrl,
    service: new L.supermap.ChartService(encUrl, { parseProperties: true }),
    layers: [], infos: []
  });
}
const srcByKey = (k) => sources.find((s) => s.key === k);

// English label for a feature-catalogue entry (iServer also returns a Chinese "localName" – not used)
function infoLabel(f) {
  const name = f.name || f.acronym || String(f.code);
  const code = f.acronym || (typeof f.code === "string" ? f.code : "");
  return code && code !== name ? `${name} (${code})` : name;
}
function featureLabel(src, key) {
  const f = src.infos.find((x) => x.acronym === key || String(x.code) === String(key));
  return f ? infoLabel(f) : key || "Feature";
}

async function loadSources() {
  const end = busy("Loading chart layers…");
  await Promise.all(
    sources.map(async (src) => {
      try {
        const r = await new L.supermap.LayerInfoService(src.url).getLayersInfo();
        src.layers = r?.result?.subLayers?.layers || [];
        if (r?.error || r?.type === "processFailed") throw r.error || new Error("processFailed");
      } catch (e) {
        console.error(`${src.key} getLayersInfo:`, e);
        src.layers = [];
        toast(`${src.label}: layer list not available – check the map service URL.`, "error", 0);
      }
      try {
        const r = await src.service.getChartFeatureInfo();
        src.infos = r?.result || [];
      } catch (e) {
        console.error(`${src.key} getChartFeatureInfo:`, e);
        src.infos = [];
        toast(`${src.label}: feature catalogue not available (query lists will be empty).`, "warn");
      }
    })
  );
  end();
  // S-100 sub-layers also drive the Layers panel
  subLayers = srcByKey("S100").layers;
  visibleLayerIdx = subLayers.map((_, i) => i);
  buildLayerList();
  buildSqlLayerList();
  loadExtents();
}

/* ============================================================
   5b. ZOOM TO EXTENT
   Extents per layer, read once and cached:
     1) bounds of each sub-layer from getLayersInfo()
     2) fallback: the map's bounds from getMapInfo() (S-100 map, ENC map)
   Converted from the map's prjCoordSys (4326 / 3857 / UTM) to Leaflet lat/lng.
============================================================ */
const extents = new Map();          // "S100:<layer>" | "S100:*" | "ENC:*"  ->  L.LatLngBounds
const extentLogged = new Set();
function setExtent(key, b, from) {
  if (!b || !b.isValid()) return;
  extents.set(key, b);
  if (!extentLogged.has(key)) {
    extentLogged.add(key);
    console.info(`Extent ${key} from ${from}:`, b.toBBoxString());
  }
}

// inverse of toUTM (WGS 84), Transverse Mercator series
function fromUTM(x, y, zone, south) {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2), e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const M = (south ? y - 10000000 : y) / k0;
  const mu = M / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256));
  const p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const N1 = a / Math.sqrt(1 - e2 * Math.sin(p1) ** 2), T1 = Math.tan(p1) ** 2, C1 = ep2 * Math.cos(p1) ** 2;
  const R1 = a * (1 - e2) / Math.pow(1 - e2 * Math.sin(p1) ** 2, 1.5), D = (x - 500000) / (N1 * k0);
  const lat = p1 - (N1 * Math.tan(p1) / R1) * (D ** 2 / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * ep2) * D ** 4 / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * ep2 - 3 * C1 ** 2) * D ** 6 / 720);
  const lon0 = ((zone - 1) * 6 - 180 + 3) * Math.PI / 180;
  const lon = lon0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * ep2 + 24 * T1 ** 2) * D ** 5 / 120) / Math.cos(p1);
  return L.latLng(lat * 180 / Math.PI, lon * 180 / Math.PI);
}

// iServer Rectangle2D (left/bottom/right/top or leftBottom/rightTop) in prjCoordSys -> L.LatLngBounds
function toLatLngBounds(r, prj) {
  if (!r) return null;
  const l = r.left ?? r.leftBottom?.x, b = r.bottom ?? r.leftBottom?.y, rt = r.right ?? r.rightTop?.x, t = r.top ?? r.rightTop?.y;
  if (![l, b, rt, t].every(Number.isFinite) || (l === rt && b === t) || Math.abs(l) > 1e15) return null;
  const epsg = +prj?.epsgCode || 0, type = String(prj?.type || "");
  let sw, ne;
  if (epsg === 4326 || /LONGITUDE_LATITUDE|GEOGRAPHIC|GCS_/i.test(type) || /DEGREE/i.test(String(prj?.coordUnit || ""))) {
    sw = L.latLng(b, l); ne = L.latLng(t, rt);
  } else if (epsg === 3857 || epsg === 900913 || /MERCATOR/i.test(type)) {
    sw = L.CRS.EPSG3857.unproject(L.point(l, b)); ne = L.CRS.EPSG3857.unproject(L.point(rt, t));
  } else {
    // projected UTM: zone from EPSG 326xx / 327xx, otherwise S102_CRS from the config
    const utm = (epsg >= 32601 && epsg <= 32660) || (epsg >= 32701 && epsg <= 32760)
      ? { zone: epsg % 100, south: epsg > 32700 } : CONFIG.S102_CRS?.type === "utm" ? CONFIG.S102_CRS : null;
    if (!utm) return null;
    sw = fromUTM(l, b, utm.zone, utm.south); ne = fromUTM(rt, t, utm.zone, utm.south);
  }
  if (Math.abs(sw.lat) > 90 || Math.abs(ne.lat) > 90) return null;
  return L.latLngBounds(sw, ne);
}
// a group layer may carry no bounds of its own: use the union of its children
function layerRect(ly) {
  if (ly?.bounds) return ly.bounds;
  const kids = ly?.subLayers?.layers || [];
  const rects = kids.map(layerRect).filter(Boolean);
  if (!rects.length) return null;
  const get = (r) => [r.left ?? r.leftBottom?.x, r.bottom ?? r.leftBottom?.y, r.right ?? r.rightTop?.x, r.top ?? r.rightTop?.y];
  const v = rects.map(get);
  return { left: Math.min(...v.map((x) => x[0])), bottom: Math.min(...v.map((x) => x[1])),
           right: Math.max(...v.map((x) => x[2])), top: Math.max(...v.map((x) => x[3])) };
}

let extentsLoading = null;
function loadExtents() {
  if (extentsLoading) return extentsLoading;
  extentsLoading = (async () => {
    for (const src of sources) {
      try {
        const info = await new L.supermap.MapService(src.url).getMapInfo();
        const res = info?.result;
        if (!res) continue;
        const prj = res.prjCoordSys;
        src.layers.forEach((ly) => setExtent(`${src.key}:${ly.name}`, toLatLngBounds(layerRect(ly), prj), "getLayersInfo"));
        setExtent(`${src.key}:*`, toLatLngBounds(res.bounds, prj), "getMapInfo bounds");
      } catch (e) {
        console.warn(`${src.key} extent:`, e);
      }
    }
  })().finally(() => { extentsLoading = null; updateExtentButtons(); });
  return extentsLoading;
}

const layerExtent = (src, name) => extents.get(`${src}:${name}`) || extents.get(`${src}:*`) || null;
// full chart extent = visible S-100 layers, or the ENC map when none is visible
function chartExtent() {
  const vis = visibleLayerIdx.map((i) => subLayers[i]).filter(Boolean);
  let b = null;
  vis.forEach((ly) => {
    const e = layerExtent("S100", ly.name);
    if (e) b = b ? L.latLngBounds(b.getSouthWest(), b.getNorthEast()).extend(e) : L.latLngBounds(e.getSouthWest(), e.getNorthEast());
  });
  return b || extents.get("ENC:*") || extents.get("S100:*") || null;
}

let extentBackView = null, extentBackTimer = null;
function zoomToExtent(bounds, label = "chart") {
  if (!bounds) return toast(`Extent of ${label} is not known yet.`, "warn", 3000);
  extentBackView = { center: map.getCenter(), zoom: map.getZoom() };
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const opts = { padding: [24, 24], maxZoom: 16 };
  reduce ? map.fitBounds(bounds, opts) : map.flyToBounds(bounds, { ...opts, duration: 0.6 });
  const back = $("btnExtentBack");
  back.classList.remove("hidden");
  clearTimeout(extentBackTimer);
  extentBackTimer = setTimeout(() => back.classList.add("hidden"), 10000);
}
function zoomBack() {
  if (!extentBackView) return;
  const v = extentBackView;
  extentBackView = null;
  $("btnExtentBack").classList.add("hidden");
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  reduce ? map.setView(v.center, v.zoom) : map.flyTo(v.center, v.zoom, { duration: 0.6 });
}
function zoomToChartExtent() {
  if ($("btnZoomExtent").classList.contains("leaflet-disabled")) return toast("iServer unreachable – extent unknown.", "warn", 3000);
  zoomToExtent(chartExtent(), "the chart");
}

// enable / disable every extent button (map control + per-layer buttons)
function updateExtentButtons() {
  const down = serverOk === false;
  const btn = $("btnZoomExtent");
  const has = !!chartExtent();
  btn.classList.toggle("leaflet-disabled", !has);
  btn.setAttribute("aria-disabled", String(!has));
  btn.dataset.tooltip = has ? "Zoom to chart extent (Z)" : down ? "iServer unreachable – extent unknown" : "Chart extent not loaded yet";
  document.querySelectorAll(".zoom-ext-btn").forEach((b) => {
    const e = layerExtent(b.dataset.src, b.dataset.layer);
    b.disabled = !e;
    b.dataset.tooltip = e ? `Zoom to ${b.dataset.label} extent` : down ? "iServer unreachable – extent unknown" : "Extent not loaded yet";
    b.title = e ? "" : b.dataset.tooltip; // native tooltip: some browsers send no mouse events to disabled buttons
  });
}
function zoomExtentButton(src, layer, label) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "zoom-ext-btn";
  b.dataset.src = src;
  b.dataset.layer = layer;
  b.dataset.label = label;
  b.setAttribute("aria-label", `Zoom to ${label} extent`);
  b.innerHTML = EXT_SVG;
  b.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation(); // never toggles the layer checkbox
    zoomToExtent(layerExtent(src, layer), label);
  };
  return b;
}
$("btnZoomExtent").onclick = (e) => { e.preventDefault(); zoomToChartExtent(); };
$("btnExtentBack").onclick = zoomBack;

/* ============================================================
   6. FEATURE QUERY – point click or area (drag a box)
      Queries ALL chart maps (ENC S-57 + S-100) and, for a point,
      also reads the S-102 depth and S-104 water level there.
============================================================ */
const identifyGroup = L.layerGroup().addTo(map);
let identifyHighlight = null;
let boxStart = null;
let boxRect = null;
const MAX_RESULTS = 500;

function setIdentifyKind(kind) {
  const already = currentMode === `identify-${kind}`;
  setMode(already ? "default" : `identify-${kind}`); // clicking the active option again turns it off
  if (already) {
    $("queryTips").textContent = QUERY_HINT;
    return;
  }
  $(kind === "point" ? "btnIdentifyPoint" : "btnIdentifyArea").classList.add("active");
  $("queryTips").textContent = kind === "point"
    ? "Click anywhere on the chart."
    : "Hold and drag a box on the chart.";
}

function onIdentifyClick(e) {
  const p = map.latLngToContainerPoint(e.latlng);
  const bounds = L.latLngBounds(
    map.containerPointToLatLng([p.x - 8, p.y + 8]),
    map.containerPointToLatLng([p.x + 8, p.y - 8])
  );
  identifyGroup.clearLayers();
  L.circleMarker(e.latlng, { radius: 6, color: ov("pick"), weight: 2, fillOpacity: 0.2, interactive: false }).addTo(identifyGroup);
  runIdentify(bounds, e.latlng);
}

function onBoxDown(e) {
  if (e.originalEvent.button !== 0) return;
  identifyGroup.clearLayers();
  boxStart = e.latlng;
  boxRect = L.rectangle(L.latLngBounds(boxStart, boxStart), {
    color: ov("pick"), weight: 1.5, dashArray: "5 5", fillOpacity: 0.08, interactive: false
  }).addTo(identifyGroup);
}
function onBoxMove(e) {
  if (boxStart && boxRect) boxRect.setBounds(L.latLngBounds(boxStart, e.latlng));
}
function onBoxUp(e) {
  if (!boxStart) return;
  const bounds = L.latLngBounds(boxStart, e.latlng);
  boxStart = null;
  const a = map.latLngToContainerPoint(bounds.getSouthWest());
  const b = map.latLngToContainerPoint(bounds.getNorthEast());
  if (Math.abs(a.x - b.x) < 6 || Math.abs(a.y - b.y) < 6) {
    identifyGroup.clearLayers();
    $("queryTips").textContent = "Box too small – drag a larger area.";
    return;
  }
  boxRect.setStyle({ dashArray: null });
  runIdentify(bounds, null);
}

let identifyToken = 0; // ignores late answers from an older query

async function runIdentify(bounds, latlng) {
  const token = ++identifyToken;
  $("groups").innerHTML = "";
  $("featuresAttr").innerHTML = "";
  identifyHighlight = null;
  const headers = new Set();
  let n = 0;
  let pending = sources.length + (latlng ? 2 : 0);
  const end = busy(latlng ? "Identify at point…" : "Identify in area…");

  const refresh = () => {
    if (token !== identifyToken) return;
    const busy = pending > 0 ? " · still loading…" : "";
    $("queryTips").textContent = n
      ? `${n} result(s)${n >= MAX_RESULTS ? ` (first ${MAX_RESULTS} shown)` : ""}${busy || " – click an item for its attributes."}`
      : busy ? "Querying…" : latlng ? "Nothing found at this point." : "Nothing found in this area.";
    if (!document.querySelector("#groups li.active")) document.querySelector("#groups li")?.click();
  };
  const done = () => { pending--; if (!pending) end(); refresh(); };
  refresh();

  // 1) vector chart features from every map – each map is shown as soon as it answers
  sources.forEach((src) => {
    src.service
      .queryChart(new L.supermap.ChartQueryParameters({ queryMode: "ChartFeatureBoundsQuery", bounds }))
      .then((res) => {
        if (token !== identifyToken) return;
        for (const rs of res?.result?.recordsets || []) {
          for (const cr of rs.chartRecordsets || []) {
            const key = cr.acronym || cr.featureCode || cr.code || cr.name;
            for (const ft of cr.features?.features || []) {
              if (n >= MAX_RESULTS) return;
              addResultItem(`${src.label} · ${rs.datasetGroupName || rs.layerName || "Chart"}`,
                featureLabel(src, key), ft.geometry?.type, ft.properties || {}, ft, headers);
              n++;
            }
          }
        }
      })
      .catch((err) => {
        console.error(`${src.key} queryChart:`, err);
        toast(`${src.label}: feature query failed.`, "error");
      })
      .finally(done);
  });

  // 2) point only: S-102 depth and S-104 water level at the clicked location
  if (latlng) {
    readS102(latlng)
      .then((c) => {
        if (token !== identifyToken || !c) return;
        addResultItem("S-100 · S-102 Bathymetry", `Depth ${c.depth.toFixed(2)} m`, "Point", {
          Depth_m: +c.depth.toFixed(3),
          Uncertainty_m: c.uncertainty !== null ? +c.uncertainty.toFixed(3) : "–",
          Dataset: c.dataset, Row: c.row, Column: c.column,
          Position: fmtPos(latlng, "ddm")
        }, null, headers);
        n++;
      })
      .catch((err) => console.error("S-102 depth:", err))
      .finally(done);

    readS104(latlng)
      .then((w) => {
        if (token !== identifyToken || !w || !w.series.length) return;
        const s = w.series;
        const at = (wla.enabled && s.find((d) => d.t === wla.times[wla.idx])) || s[0];
        const hs = s.map((d) => d.h);
        const [lng, lat] = w.station.geometry.coordinates;
        addResultItem("S-100 · S-104 Water Level", `Water level ${at.h.toFixed(2)} m @ ${fmtTime(at.t)}`, "Point", {
          WaterLevel_m: +at.h.toFixed(3), TimePoint: fmtTime(at.t),
          Min_m: +Math.min(...hs).toFixed(3), Max_m: +Math.max(...hs).toFixed(3), TimeSteps: s.length,
          Method: S104_METHOD[w.method],
          NearestGridPoint: `${fmtPos(L.latLng(lat, lng), "ddm")} (${Math.round(w.nearestDist)} m / ${fmtBrg(w.nearestBrg)})`,
          StationID: prop(w.station.properties, "stationID") ?? "–", CellID: prop(w.station.properties, "cellID") ?? "–"
        }, null, headers);
        n++;
      })
      .catch((err) => console.error("S-104 water level:", err))
      .finally(done);
  }
}

function addResultItem(group, label, geomType, props, feature, headers) {
  if (!headers.has(group)) {
    headers.add(group);
    const hdr = document.createElement("div");
    hdr.className = "group-title";
    hdr.textContent = group;
    $("groups").append(hdr);
  }
  const li = document.createElement("li");
  li.className = "feature-item";
  li.innerHTML = `<img src="${imgSrc[geomType] || imgSrc.Point}" class="w-4 h-4"><span>${label}</span>`;
  const table = attrTable(props);
  table.classList.add("hidden");
  $("featuresAttr").append(table);
  li.onclick = () => {
    document.querySelectorAll("#featuresAttr > table").forEach((t) => t.classList.add("hidden"));
    document.querySelectorAll("#groups li").forEach((x) => x.classList.remove("active"));
    li.classList.add("active");
    table.classList.remove("hidden");
    if (identifyHighlight) identifyGroup.removeLayer(identifyHighlight);
    identifyHighlight = null;
    if (feature?.geometry) {
      identifyHighlight = L.geoJSON(feature, {
        style: () => ({ color: ov("hi"), weight: 3, fillOpacity: 0.15 }),
        pointToLayer: (f, ll) => L.circleMarker(ll, { radius: 8, color: ov("hi"), weight: 3, fillOpacity: 0.2 }),
        interactive: false
      }).addTo(identifyGroup);
    }
  };
  $("groups").append(li);
}

/* ---------- fast, cached readers for the S-102 / S-104 coverages ---------- */
const featureService = new L.supermap.FeatureService(DATA_URL);
// read a property case-insensitively (UDBX field "stationID" may come back as "STATIONID")
const prop = (o, k) => {
  if (!o) return undefined;
  if (k in o) return o[k];
  const K = k.toUpperCase();
  for (const x in o) if (x.toUpperCase() === K) return o[x];
  return undefined;
};

// S-102: the depth (_D) and uncertainty (_U) grids, read ONCE from the data service
let depthGridsPromise = null;
function getDepthGrids() {
  if (!depthGridsPromise) {
    const ds = CONFIG.S102_DATASOURCE || CONFIG.S104_DATASOURCE;
    depthGridsPromise = fetch(`${DATA_URL}/datasources/${encodeURIComponent(ds)}/datasets.json`)
      .then((r) => r.json())
      .then((j) => {
        const grids = (j.datasetNames || []).filter((n) => /_(D|U)$/.test(n)).map((n) => [ds, n]);
        console.info("S-102 grids used for the depth query:", grids);
        if (!grids.length) console.warn(`No S-102 *_D / *_U grids found in datasource "${ds}"`);
        return grids;
      })
      .catch((e) => { depthGridsPromise = null; throw e; });
  }
  return depthGridsPromise;
}
// NOTE: we call the REST gridValue resource directly. iClient's GridCellInfosService keeps
// appending "/datasources/.../datasets/<name>" to its own URL on every call, so a shared
// instance produced ever-longer 404 URLs (and "reading 'type'" errors) after the first query.
const S102_NODATA = 99999; // S-102 fill value is 1 000 000; anything this large is "no data"
async function gridValue(ds, name, X, Y) {
  const url = `${DATA_URL}/datasources/${encodeURIComponent(ds)}/datasets/${encodeURIComponent(name)}` +
    `/gridValue.json?x=${X}&y=${Y}`;
  const r = await fetch(url);
  if (!r.ok) return null; // outside the grid extent iServer answers 400/404
  const j = await r.json();
  return j && typeof j.value === "number" && Math.abs(j.value) < S102_NODATA ? j : null;
}
async function readS102(latlng) {
  const { X, Y } = toS102XY(latlng);
  const grids = await getDepthGrids();
  const answers = await Promise.all(grids.map(([ds, name]) =>
    gridValue(ds, name, X, Y)
      .then((r) => ({ name, r }))
      .catch((e) => { console.warn(`gridValue ${name}:`, e); return { name, r: null }; })
  ));
  const d = answers.find((a) => /_D$/.test(a.name) && a.r);
  if (!d) return null;
  const u = answers.find((a) => a.name === d.name.replace(/_D$/, "_U") && a.r);
  return { depth: d.r.value, uncertainty: u ? u.r.value : null, dataset: d.name, row: d.r.row, column: d.r.column };
}

// S-104: our own nearest-station search. (iClient's getWaterLevel only looks at the first 20
// points inside a 0.03° buffer, so it often picks a point far from the click.)
async function s104GridAround(latlng) {
  const ds = CONFIG.S104_DATASOURCE;
  for (const r of [0.0025, 0.008, 0.03]) { // grid spacing is ~0.002°; widen only if nothing is found
    const res = await featureService.getFeaturesByBounds(
      new L.supermap.GetFeaturesByBoundsParameters({
        datasetNames: [`${ds}:${CONFIG.S104_POSITION_DATASET}`],
        bounds: L.latLngBounds([latlng.lat - r, latlng.lng - r], [latlng.lat + r, latlng.lng + r]),
        spatialQueryMode: "INTERSECT",
        fromIndex: 0,
        toIndex: -1,
        maxFeatures: 5000
      })
    );
    const feats = res?.result?.features?.features || [];
    if (feats.length) return feats;
  }
  return [];
}

// time table of a cell (timeID -> timePoint), cached
const s104TimeCache = new Map();
function s104TimeMap(cellId) {
  if (!s104TimeCache.has(cellId)) {
    const ds = CONFIG.S104_DATASOURCE, t = CONFIG.S104_TIME_DATASET;
    s104TimeCache.set(cellId, featureService.getFeaturesBySQL(new L.supermap.GetFeaturesBySQLParameters({
      datasetNames: [`${ds}:${t}`],
      queryParameter: { name: `${t}@${ds}`, attributeFilter: `cellID = ${cellId}` },
      fromIndex: 0, toIndex: -1, maxFeatures: 100000
    })).then((res) => {
      const m = new Map();
      (res?.result?.features?.features || []).forEach((f) => m.set(String(prop(f.properties, "timeID")), prop(f.properties, "timePoint")));
      return m;
    }).catch((e) => { s104TimeCache.delete(cellId); throw e; }));
  }
  return s104TimeCache.get(cellId);
}

// full time series of one station (fast thanks to the stationID/cellID index), cached per station
const s104SeriesCache = new Map();
function s104Series(stationId, cellId) {
  const key = `${stationId}|${cellId}`;
  if (!s104SeriesCache.has(key)) {
    const ds = CONFIG.S104_DATASOURCE, wl = CONFIG.S104_WATERLEVEL_DATASET;
    s104SeriesCache.set(key, Promise.all([
      featureService.getFeaturesBySQL(new L.supermap.GetFeaturesBySQLParameters({
        datasetNames: [`${ds}:${wl}`],
        queryParameter: { name: `${wl}@${ds}`, attributeFilter: `stationID = ${stationId} AND cellID = ${cellId}` },
        fromIndex: 0, toIndex: -1, maxFeatures: 100000
      })),
      s104TimeMap(cellId)
    ]).then(([res, times]) => (res?.result?.features?.features || [])
      .map((f) => ({ t: times.get(String(prop(f.properties, "timeID"))), h: +prop(f.properties, "waterLevelHeight") }))
      .filter((d) => d.t && !Number.isNaN(d.h))
      .sort((a, b) => (a.t < b.t ? -1 : 1))
    ).catch((e) => { s104SeriesCache.delete(key); throw e; }));
  }
  return s104SeriesCache.get(key);
}

/* S-104 water level AT the clicked point.
   NOAA S-104 is a regular grid (~0.002°), so the value is interpolated from the grid points around the click:
   - bilinear  when the 4 surrounding points (one per quadrant) form a grid cell
   - IDW       (inverse distance², up to 4 points) near the coast where some cell corners are missing
   - nearest   when only one grid point is available
   The nearest grid point is still returned so the map can show where the S-104 data comes from. */
async function readS104(latlng) {
  const feats = await s104GridAround(latlng);
  if (!feats.length) return null;
  const pts = feats.map((f) => {
    const [x, y] = f.geometry.coordinates;
    const ll = L.latLng(y, x);
    return { f, ll, d: latlng.distanceTo(ll) };
  });
  const nearest = pts.reduce((a, b) => (b.d < a.d ? b : a));

  // nearest grid point in each quadrant around the click
  const quad = {};
  pts.forEach((p) => {
    const q = (p.ll.lat >= latlng.lat ? "N" : "S") + (p.ll.lng >= latlng.lng ? "E" : "W");
    if (!quad[q] || p.d < quad[q].d) quad[q] = p;
  });
  const { NW, NE, SW, SE } = quad;
  let method = "nearest", weights = [[nearest, 1]];
  if (nearest.d >= 0.5 && NW && NE && SW && SE) {
    const dx = Math.abs(NE.ll.lng - NW.ll.lng) || 1e-9, dy = Math.abs(NE.ll.lat - SE.ll.lat) || 1e-9;
    const tol = 0.25 * Math.max(dx, dy);
    const aligned = Math.abs(SW.ll.lng - NW.ll.lng) < tol && Math.abs(SE.ll.lng - NE.ll.lng) < tol &&
      Math.abs(SW.ll.lat - SE.ll.lat) < tol && Math.abs(NW.ll.lat - NE.ll.lat) < tol && dx < 0.02 && dy < 0.02;
    if (aligned) {
      const x0 = (SW.ll.lng + NW.ll.lng) / 2, x1 = (SE.ll.lng + NE.ll.lng) / 2;
      const y0 = (SW.ll.lat + SE.ll.lat) / 2, y1 = (NW.ll.lat + NE.ll.lat) / 2;
      const tx = Math.min(1, Math.max(0, (latlng.lng - x0) / (x1 - x0)));
      const ty = Math.min(1, Math.max(0, (latlng.lat - y0) / (y1 - y0)));
      method = "bilinear";
      weights = [[SW, (1 - tx) * (1 - ty)], [SE, tx * (1 - ty)], [NW, (1 - tx) * ty], [NE, tx * ty]];
    }
  }
  if (method === "nearest" && nearest.d >= 0.5) {
    const near = Object.values(quad).filter((p) => p.d < 3 * nearest.d + 1); // ignore far-away corners
    if (near.length > 1) {
      method = "idw";
      weights = near.map((p) => [p, 1 / (p.d * p.d)]);
    }
  }
  const used = weights.filter(([, w]) => w > 1e-9);
  const series = await Promise.all(used.map(([p]) => s104Series(prop(p.f.properties, "stationID"), prop(p.f.properties, "cellID"))));
  // weighted sum per time step (weights re-normalised if a station misses a time step)
  const maps = series.map((sr) => new Map(sr.map((d) => [d.t, d.h])));
  const times = [...new Set(series.flat().map((d) => d.t))].sort();
  const out = [];
  times.forEach((t) => {
    let sw = 0, sh = 0;
    used.forEach(([, w], i) => {
      const h = maps[i].get(t);
      if (h !== undefined) { sw += w; sh += w * h; }
    });
    if (sw > 0) out.push({ t, h: sh / sw });
  });
  return {
    station: nearest.f,            // nearest grid point (shown on the map)
    series: out,                   // water level interpolated at the click
    method,
    points: used.map(([p]) => p.ll),
    nearestDist: nearest.d,
    nearestBrg: bearing(latlng, nearest.ll),
    at: latlng
  };
}
const S104_METHOD = { bilinear: "bilinear, 4 grid points", idw: "IDW, nearby grid points", nearest: "nearest grid point" };
const s104Source = (w) => `${S104_METHOD[w.method]} · nearest grid point ${Math.round(w.nearestDist)} m / ${fmtBrg(w.nearestBrg)}`;

// water level at a time for a location (used by the depth probe)
async function waterLevelAt(latlng, timePoint) {
  const w = await readS104(latlng);
  const d = w?.series.find((x) => x.t === timePoint);
  return d ? { h: d.h, w } : null;
}

/* Map graphics that show where the S-104 value comes from:
   dashed line + label from the clicked point to the nearest grid point, and the grid points used */
function drawS104Link(group, w) {
  group.clearLayers();
  if (group._sync) map.off("zoomend", group._sync);
  group._sync = null;
  const hi = ov("hi");
  const nearLL = L.latLng(w.station.geometry.coordinates[1], w.station.geometry.coordinates[0]);
  w.points.forEach((ll) => L.circleMarker(ll, { radius: 4, color: hi, weight: 1.5, fillOpacity: 0, opacity: 0.7, interactive: false }).addTo(group));
  L.circleMarker(nearLL, { radius: 7, color: hi, weight: 3, fillOpacity: 0.3, interactive: false }).addTo(group);
  if (w.nearestDist >= 0.5) {
    L.polyline([w.at, nearLL], { color: hi, weight: 1.5, dashArray: "4 4", interactive: false }).addTo(group);
    const tip = L.tooltip({ permanent: true, direction: "center", className: "measure-label s104-link-label" })
      .setLatLng(L.latLngBounds(w.at, nearLL).getCenter())
      .setContent(`${Math.round(w.nearestDist)} m · ${fmtBrg(w.nearestBrg)}`);
    // the distance label only when the link is long enough on screen (it would cover the UKC label otherwise)
    group._sync = () => {
      const px = map.latLngToContainerPoint(w.at).distanceTo(map.latLngToContainerPoint(nearLL));
      if (px >= 90) group.addLayer(tip); else group.removeLayer(tip);
    };
    map.on("zoomend", group._sync);
    group._sync();
  }
}

// Nested table so S-101 complex attributes / information associations stay readable
function attrTable(obj) {
  const table = document.createElement("table");
  table.className = "attr-table";
  Object.entries(obj).forEach(([k, v]) => {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.textContent = k;
    const td = document.createElement("td");
    let val = v;
    if (typeof val === "string" && /^[\[{]/.test(val.trim())) {
      try { val = JSON.parse(val); } catch { /* keep string */ }
    }
    if (val && typeof val === "object") {
      const inner = Array.isArray(val) ? Object.fromEntries(val.map((x, i) => [`[${i}]`, x])) : val;
      const nested = attrTable(inner);
      nested.classList.add("nested");
      td.append(nested);
    } else {
      td.textContent = val ?? "";
    }
    tr.append(th, td);
    table.append(tr);
  });
  return table;
}

$("btnIdentifyPoint").onclick = () => setIdentifyKind("point");
$("btnIdentifyArea").onclick = () => setIdentifyKind("area");
$("btnIdentifyOff").onclick = () => {
  setMode("default");
  identifyGroup.clearLayers();
  identifyHighlight = null;
  $("groups").innerHTML = "";
  $("featuresAttr").innerHTML = "";
  $("queryTips").textContent = QUERY_HINT;
};

/* ============================================================
   7. ATTRIBUTE QUERY (ChartAttributeQuery) on any chart layer
      S-57: numeric object code · S-100/S-101: feature code name
============================================================ */
function buildSqlLayerList() {
  const ddl = $("chartLayers");
  ddl.innerHTML = "";
  sources.forEach((src) => {
    if (!src.layers.length) return;
    const og = document.createElement("optgroup");
    og.label = src.key === "ENC" ? "ENC (S-57)" : "S-100";
    src.layers.forEach((l) => {
      const o = document.createElement("option");
      o.value = `${src.key}|${l.name}`;
      o.textContent = l.caption || l.name;
      og.append(o);
    });
    ddl.append(og);
  });
  ddl.onchange = fillFeatureTypes;
  fillFeatureTypes();
}

function fillFeatureTypes() {
  const [key] = ($("chartLayers").value || "").split("|");
  const src = srcByKey(key);
  const list = $("featuresList");
  list.innerHTML = "";
  if (!src) return;
  [...src.infos]
    .sort((a, b) => infoLabel(a).localeCompare(infoLabel(b)))
    .forEach((f) => {
      const o = document.createElement("option");
      o.value = f.code;
      o.textContent = infoLabel(f);
      list.append(o);
    });
}

function sqlQuery() {
  const [key, layerName] = ($("chartLayers").value || "").split("|");
  const src = srcByKey(key);
  if (!src) return toast("No chart layer available to query.", "warn");
  const code = $("featuresList").value;
  const attributeFilter = $("attributeFilter").value.trim() || undefined;
  const isS57 = /^\d+$/.test(code); // S-57 object codes are numeric, S-100 feature codes are names
  const filter = new L.supermap.ChartQueryFilterParameter(
    isS57
      ? { chartFeatureInfoSpecCode: +code, attributeFilter, isQueryPoint: true, isQueryLine: true, isQueryRegion: true }
      : { featureCode: code, attributeFilter }
  );
  const params = new L.supermap.ChartQueryParameters({
    queryMode: "ChartAttributeQuery",
    chartLayerNames: [layerName],
    startRecord: 0,
    expectCount: 1000,
    returnContent: true,
    chartQueryFilterParameters: [filter]
  });

  const out = $("queryResults");
  out.innerHTML = `<li class="hint">Querying…</li>`;
  clearSql(false);
  const end = busy("Attribute query…");

  src.service.queryChart(params).then((res) => {
    const sets = res?.result?.recordsets || [];
    const feats = [];
    sets.forEach((rs) => {
      if (rs.features?.features) feats.push(...rs.features.features);
      (rs.chartRecordsets || []).forEach((cr) => feats.push(...(cr.features?.features || [])));
    });
    out.innerHTML = "";
    if (!feats.length) {
      out.innerHTML = `<li class="hint">No features match this query.</li>`;
      return;
    }
    const style = { color: ov("hi"), weight: 3, fillOpacity: 0.1 };
    sqlResultLayer = L.geoJSON({ type: "FeatureCollection", features: feats }, {
      style: () => style,
      pointToLayer: (f, ll) => L.circleMarker(ll, { radius: 6, ...style })
    }).addTo(map);
    const head = document.createElement("li");
    head.className = "hint";
    head.textContent = `${feats.length} feature(s) – click one to zoom`;
    out.append(head);
    const label = featureLabel(src, code);
    feats.forEach((f, i) => {
      const li = document.createElement("li");
      li.className = "feature-item";
      const name = f.properties?.OBJNAM || f.properties?.featureName || "";
      li.innerHTML = `<img src="${imgSrc[f.geometry?.type] || imgSrc.Point}" class="w-4 h-4"><span>${label} #${i + 1}${name ? ` – ${name}` : ""}</span>`;
      li.onclick = () => {
        const b = L.geoJSON(f).getBounds();
        b.isValid() && map.fitBounds(b, { padding: [30, 30], maxZoom: 16 });
      };
      out.append(li);
    });
    try { map.fitBounds(sqlResultLayer.getBounds(), { padding: [30, 30], maxZoom: 15 }); } catch { /* no bounds */ }
  }).catch((err) => {
    console.error(err);
    out.innerHTML = `<li class="hint">Query failed.</li>`;
    toast("Attribute query failed – check the filter syntax and the iServer connection.", "error");
  }).finally(end);
}

function clearSql(clearList = true) {
  if (clearList) $("queryResults").innerHTML = "";
  if (sqlResultLayer) map.removeLayer(sqlResultLayer);
  sqlResultLayer = null;
}
$("btnSqlRun").onclick = sqlQuery;
$("btnSqlClear").onclick = () => clearSql(true);

/* ============================================================
   8. LAYERS (S-100 sub-layers + basemaps)
============================================================ */
function buildLayerList() {
  const list = $("layerList");
  list.innerHTML = "";
  if (!subLayers.length) {
    list.innerHTML = serverOk === false
      ? `<li class="hint layer-down">iServer unreachable – chart layers unavailable.</li>`
      : `<li class="hint">No chart layers loaded.</li>`;
  }
  subLayers.forEach((ly, i) => {
    const li = document.createElement("li");
    li.className = "layer-item";
    const on = visibleLayerIdx.includes(i);
    li.innerHTML = `<label><input type="checkbox" ${on ? "checked" : ""}/> <span class="lname truncate">${ly.caption || ly.name}</span></label>`;
    li.append(zoomExtentButton("S100", ly.name, ly.caption || ly.name));
    li.querySelector("input").onchange = (e) => {
      visibleLayerIdx = e.target.checked
        ? [...new Set([...visibleLayerIdx, i])].sort((a, b) => a - b)
        : visibleLayerIdx.filter((x) => x !== i);
      // iServer tileImage layersID syntax: [0:i,j,k] = visible sub-layers of layer 0
      chartLayer.updateParams({
        layersID: visibleLayerIdx.length === subLayers.length ? undefined : `[0:${visibleLayerIdx.join(",")}]`
      });
    };
    list.append(li);
  });
  updateExtentButtons();
}

const basemaps = {
  "OpenStreetMap": L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, subdomains: ["a", "b", "c"], attribution: "© OpenStreetMap contributors"
  }),
  "SuperMap World": new L.supermap.TiledMapLayer(
    "https://iserver.supermap.io/iserver/services/map-world/rest/maps/World",
    { prjCoordSys: { epsgCode: 3857 }, noWrap: true }
  )
};
// one small image per online basemap, used to test reachability even when it is not selected
// (Image() instead of fetch: no CORS needed)
const BASEMAP_PROBE = {
  "OpenStreetMap": "https://tile.openstreetmap.org/0/0/0.png",
  "SuperMap World": "https://iserver.supermap.io/iserver/services/map-world/rest/maps/World/entireImage.png?width=16&height=16"
};
const basemapState = {}; // name -> { badge, state, warned }

function setBadge(name, state) {
  const st = basemapState[name];
  if (!st || st.state === state) return;
  st.state = state;
  st.badge.className = `bm-status ${state}`;
  st.badge.textContent = state === "online" ? "ONLINE" : state === "offline" ? "OFFLINE" : "CHECKING…";
}
function probeImage(url, ms = 5000) {
  return new Promise((resolve) => {
    const img = new Image();
    const t = setTimeout(() => { img.src = ""; resolve(false); }, ms);
    img.onload = () => { clearTimeout(t); resolve(true); };
    img.onerror = () => { clearTimeout(t); resolve(false); };
    img.src = url + (url.includes("?") ? "&" : "?") + "_=" + Date.now();
  });
}
async function checkBasemaps() {
  await Promise.all(Object.keys(BASEMAP_PROBE).map(async (name) => {
    setBadge(name, (await probeImage(BASEMAP_PROBE[name])) ? "online" : "offline");
  }));
}
// live status of the selected basemap (tile errors / loads) updates the same badge
function watchOnline(name, layer) {
  let failed = 0;
  layer.on("tileerror", () => {
    if (++failed < 3) return;
    setBadge(name, "offline");
    const st = basemapState[name];
    if (!st.warned) {
      st.warned = true;
      toast(`${name} is unreachable (closed network?). Use the ENC base chart instead.`, "warn");
    }
  });
  layer.on("tileload", () => { failed = 0; setBadge(name, "online"); });
}

function buildBasemapList() {
  const list = $("basemapList");
  list.innerHTML = "";
  if (encLayer) {
    const li = document.createElement("li");
    li.className = "layer-item";
    li.innerHTML = `<label><input type="checkbox" checked/> <span class="lname">ENC base chart (S-57, S-52)</span></label>`;
    li.append(zoomExtentButton("ENC", "*", "ENC base chart"));
    li.querySelector("input").onchange = (e) => (e.target.checked ? encLayer.addTo(map) : map.removeLayer(encLayer));
    list.append(li);
  }
  [["None", null], ...Object.entries(basemaps)].forEach(([name, layer], i) => {
    const li = document.createElement("li");
    li.className = "layer-item";
    li.innerHTML = `<label><input type="radio" name="basemap" ${i === 0 ? "checked" : ""}/> <span class="lname">${name}</span></label>`;
    if (layer) {
      const badge = document.createElement("span");
      li.append(badge);
      basemapState[name] = { badge, state: null, warned: false };
      setBadge(name, "checking");
      watchOnline(name, layer);
    }
    li.querySelector("input").onchange = () => {
      Object.values(basemaps).forEach((b) => map.hasLayer(b) && map.removeLayer(b));
      if (layer) {
        basemapState[name].warned = false;
        layer.addTo(map);
        layer.setZIndex(0);
      }
    };
    list.append(li);
  });
  checkBasemaps();
  setInterval(checkBasemaps, 60000);
  window.addEventListener("online", checkBasemaps); // re-check as soon as the OS reports a network
}

/* ============================================================
   9. MEASUREMENT (geodesic, nautical units first)
============================================================ */
let measurePts = [];
let measureLayer = null;   // shape currently being drawn
let coordMarker = null;
const measureGroup = L.layerGroup().addTo(map); // holds ALL finished + current measurement graphics
let measureKind = null; // no tool selected until the user picks one

const DIST = { m: 1, km: 1000, nmi: 1852, cable: 185.2 };
const DIST_LABEL = { m: "m", km: "km", nmi: "NM", cable: "cbl" };
const DIST_DEC = { m: 0, km: 3, nmi: 3, cable: 1 };
const AREA = { sqm: 1, hectares: 1e4, sqkm: 1e6, sqnmi: 1852 * 1852 };
const AREA_LABEL = { sqm: "m²", hectares: "ha", sqkm: "km²", sqnmi: "NM²" };

const MEASURE_HINT = "Choose a tool above to start measuring.";
let rubberLine = null; // dashed preview line from the last vertex to the cursor
let lastClick = null;
let lastCursor = null;

function clearMeasure() {
  measurePts = [];
  measureGroup.clearLayers();
  measureLayer = coordMarker = rubberLine = null;
  lastClick = lastCursor = null;
  $("measureResult").textContent = measureKind ? startHint() : MEASURE_HINT;
}

function startHint() {
  return measureKind === "coord"
    ? "Move the cursor or click the chart."
    : "Click the chart to place the first point.";
}

// Called when the user leaves the measurement tools (other tab / other tool)
function resetMeasureTool() {
  measureKind = null;
  if (rubberLine) measureGroup.removeLayer(rubberLine);
  rubberLine = null;
  document.querySelectorAll(".measure-icon-btn").forEach((b) => b.classList.remove("active"));
  ["distanceUnitGroup", "areaUnitGroup", "coordUnitGroup", "btnCoordCopy"].forEach((id) => $(id).classList.add("hidden"));
}

function setMeasureKind(kind) {
  if (measureKind === kind) {           // clicking the active tool again turns it off
    setMode("default");
    $("measureResult").textContent = MEASURE_HINT;
    return;
  }
  setMode(`measure-${kind}`);           // (resets previous tool first)
  measureKind = kind;
  clearMeasure();
  document.querySelectorAll(".measure-icon-btn").forEach((b) => b.classList.remove("active"));
  $(`btnMeasure${kind[0].toUpperCase()}${kind.slice(1)}`).classList.add("active");
  $("distanceUnitGroup").classList.toggle("hidden", kind !== "distance");
  $("areaUnitGroup").classList.toggle("hidden", kind !== "area");
  $("coordUnitGroup").classList.toggle("hidden", kind !== "coord");
  $("btnCoordCopy").classList.toggle("hidden", kind !== "coord");
}

function polyLength(p) {
  return p.reduce((s, q, i) => (i ? s + p[i - 1].distanceTo(q) : 0), 0);
}
function polyArea(p) {
  if (p.length < 3) return 0;
  const R = 6378137, r = Math.PI / 180;
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const j = (i + 1) % p.length;
    s += (p[j].lng - p[i].lng) * r * (2 + Math.sin(p[i].lat * r) + Math.sin(p[j].lat * r));
  }
  return Math.abs((s * R * R) / 2);
}
// initial great-circle bearing, degrees true
function bearing(a, b) {
  const r = Math.PI / 180, f1 = a.lat * r, f2 = b.lat * r, dl = (b.lng - a.lng) * r;
  const t = Math.atan2(Math.sin(dl) * Math.cos(f2), Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl));
  return (t / r + 360) % 360;
}
const fmtBrg = (d) => `${String(Math.round(d) % 360).padStart(3, "0")}°T`;
function fmtDist(m) {
  const u = $("distanceUnit").value;
  return `${(m / DIST[u]).toFixed(DIST_DEC[u])} ${DIST_LABEL[u]}`;
}
function fmtArea(m2) {
  const u = $("areaUnit").value;
  return `${(m2 / AREA[u]).toFixed(3)} ${AREA_LABEL[u]}`;
}

function measureText(final, cursor) {
  if (measureKind === "distance") {
    const lines = [];
    for (let i = 1; i < measurePts.length; i++) {
      const a = measurePts[i - 1], b = measurePts[i];
      lines.push(`Leg ${i}   ${fmtBrg(bearing(a, b))}   ${fmtDist(a.distanceTo(b))}`);
    }
    if (!final && cursor && measurePts.length) {
      const last = measurePts[measurePts.length - 1];
      lines.push(`→ cursor ${fmtBrg(bearing(last, cursor))}   ${fmtDist(last.distanceTo(cursor))}`);
    }
    lines.push(`${final ? "TOTAL" : "Total so far"}   ${fmtDist(polyLength(measurePts))}`);
    if (!final) lines.push("Double-click to finish");
    return lines.join("\n");
  }
  if (measurePts.length < 3 && !final) return `${measurePts.length} point(s) – add at least 3, double-click to finish`;
  const perim = polyLength([...measurePts, measurePts[0]]);
  return `${final ? "AREA" : "Area so far"}   ${fmtArea(polyArea(measurePts))}\nPerimeter   ${fmtDist(perim)}` +
    (final ? "" : `\n${measurePts.length} point(s) – double-click to finish`);
}

const measureColor = () => (measureKind === "distance" ? ov("dist") : ov("area"));

function onMeasureClick(e) {
  // a double-click fires two clicks at the same spot: ignore the duplicate vertex
  const last = measurePts[measurePts.length - 1];
  if (last && map.latLngToContainerPoint(last).distanceTo(map.latLngToContainerPoint(e.latlng)) < 4) return;

  const color = measureColor();
  measurePts.push(e.latlng);
  // vertex marker (first point slightly larger)
  L.circleMarker(e.latlng, {
    radius: measurePts.length === 1 ? 6 : 4.5,
    color, weight: 2, fillColor: theme === "night" ? "#000" : "#ffffff", fillOpacity: 1, interactive: false
  }).addTo(measureGroup);

  if (!measureLayer) {
    measureLayer = measureKind === "distance"
      ? L.polyline(measurePts, { color, weight: 3, interactive: false })
      : L.polygon(measurePts, { color, weight: 2, fillOpacity: 0.2, interactive: false });
    measureGroup.addLayer(measureLayer);
    measureLayer.bringToBack();
  } else {
    measureLayer.setLatLngs(measurePts);
  }
  $("measureResult").textContent = measureText(false);
}

function onMeasureMove(e) {
  if (!measurePts.length) return;
  const last = measurePts[measurePts.length - 1];
  const pts = measureKind === "area" && measurePts.length > 1 ? [last, e.latlng, measurePts[0]] : [last, e.latlng];
  if (!rubberLine) {
    rubberLine = L.polyline(pts, {
      color: measureColor(), weight: 2, dashArray: "6 6", opacity: 0.8, interactive: false
    }).addTo(measureGroup);
  } else {
    rubberLine.setLatLngs(pts);
  }
  if (measureKind === "distance") $("measureResult").textContent = measureText(false, e.latlng);
}

function onMeasureDbl() {
  if (rubberLine) measureGroup.removeLayer(rubberLine);
  rubberLine = null;
  const enough = measureKind === "distance" ? measurePts.length >= 2 : measurePts.length >= 3;
  $("measureResult").textContent = enough
    ? measureText(true)
    : `Not enough points – ${measureKind === "distance" ? "2" : "3"} needed. Start again.`;
  if (enough) {
    // keep a label on the chart so the result stays readable during a briefing
    const isDist = measureKind === "distance";
    const where = isDist ? measurePts[measurePts.length - 1] : L.latLngBounds(measurePts).getCenter();
    const text = isDist
      ? fmtDist(polyLength(measurePts)) + (measurePts.length === 2 ? ` · ${fmtBrg(bearing(measurePts[0], measurePts[1]))}` : "")
      : fmtArea(polyArea(measurePts));
    measureGroup.addLayer(
      L.tooltip({ permanent: true, direction: isDist ? "right" : "center", offset: isDist ? [10, 0] : [0, 0], className: "measure-label" })
        .setLatLng(where)
        .setContent(text)
    );
  }
  measurePts = [];
  measureLayer = null; // keep the finished shape; next click starts a new one
}

/* ---------- position formats: DDM (default for navigators), DMS, DD, UTM ---------- */
function hemi(v, isLat) { return v >= 0 ? (isLat ? "N" : "E") : isLat ? "S" : "W"; }
function toDDM(v, isLat) {
  const a = Math.abs(v);
  let d = Math.floor(a), m = +((a - d) * 60).toFixed(3);
  if (m >= 60) { d += 1; m = 0; }
  return `${String(d).padStart(isLat ? 2 : 3, "0")}°${m.toFixed(3).padStart(6, "0")}'${hemi(v, isLat)}`;
}
function toDMS(v, isLat) {
  const cs = Math.round(Math.abs(v) * 360000); // hundredths of a second
  const d = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), s = (cs % 6000) / 100;
  return `${String(d).padStart(isLat ? 2 : 3, "0")}°${String(m).padStart(2, "0")}'${s.toFixed(2).padStart(5, "0")}"${hemi(v, isLat)}`;
}
function toUTMString(ll) {
  const zone = Math.min(60, Math.floor((ll.lng + 180) / 6) + 1);
  const band = "CDEFGHJKLMNPQRSTUVWXX"[Math.max(0, Math.min(20, Math.floor((ll.lat + 80) / 8)))];
  const p = toUTM(ll.lat, ll.lng, zone, ll.lat < 0);
  return `${zone}${band} ${Math.round(p.x)}E ${Math.round(p.y)}N`;
}
function fmtPos(ll, fmt = "ddm") {
  if (fmt === "utm") return toUTMString(ll);
  if (fmt === "dms") return `${toDMS(ll.lat, true)} ${toDMS(ll.lng, false)}`;
  if (fmt === "deg" || fmt === "dd") {
    return `${Math.abs(ll.lat).toFixed(5)}°${hemi(ll.lat, true)} ${Math.abs(ll.lng).toFixed(5)}°${hemi(ll.lng, false)}`;
  }
  return `${toDDM(ll.lat, true)} ${toDDM(ll.lng, false)}`;
}
function fmtLatLng(ll) {
  return fmtPos(ll, $("coordUnit").value);
}
function onCoordMove(e) {
  lastCursor = e.latlng;
  $("measureResult").textContent = `Cursor   ${fmtLatLng(e.latlng)}` + (lastClick ? `\nPicked   ${fmtLatLng(lastClick)}` : "");
}
function onCoordClick(e) {
  lastClick = e.latlng;
  if (!coordMarker) coordMarker = L.circleMarker(e.latlng, { radius: 5, color: ov("hi"), weight: 2, fillOpacity: 0.8 }).addTo(measureGroup);
  else coordMarker.setLatLng(e.latlng);
  onCoordMove(e);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // clipboard API needs https/localhost – fall back to a hidden textarea
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}
$("btnCoordCopy").onclick = async () => {
  const ll = lastClick || lastCursor;
  if (!ll) return toast("Click the chart to pick a position first.", "warn", 3000);
  const text = fmtLatLng(ll);
  await copyText(text);
  toast(`Copied: ${text}`, "ok", 3000);
};
$("coordUnit").onchange = () => { if (lastCursor) onCoordMove({ latlng: lastCursor }); };

$("btnMeasureDistance").onclick = () => setMeasureKind("distance");
$("btnMeasureArea").onclick = () => setMeasureKind("area");
$("btnMeasureCoord").onclick = () => setMeasureKind("coord");
$("btnMeasureClear").onclick = clearMeasure;

/* ============================================================
   UI: tabs, sidebar, tooltip, keyboard, status bar
============================================================ */
function initTabs() {
  const tabs = document.querySelectorAll("#toolbarTabs .tab-btn");
  const panels = document.querySelectorAll(".tab-panel");
  const show = (id) => {
    panels.forEach((p) => p.classList.toggle("hidden", p.id !== id));
    tabs.forEach((t) => t.classList.toggle("active-tab", t.dataset.panel === id));
  };
  tabs.forEach((b) => (b.onclick = () => {
    if ($("toolbar").classList.contains("sidebar-minimized")) setSidebar(false); // a tab click opens the panel
    show(b.dataset.panel);
    setMode("default"); // no tool is pre-selected when a tab opens
  }));
  show("settings");
}

function setSidebar(minimized) {
  $("toolbar").classList.toggle("sidebar-minimized", minimized);
  store.set("sidebar", minimized ? "min" : "open");
  setTimeout(() => map.invalidateSize(), 250); // map fills the freed space
}
function initSidebar() {
  $("btnExpand").onclick = () => setSidebar(false);
  $("btnCollapse").onclick = () => setSidebar(true);
  if (store.get("sidebar") === "min") setSidebar(true);
}

// one delegated tooltip for every [data-tooltip] (also for elements created later)
function initTooltip() {
  const tip = $("tooltip");
  let cur = null;
  document.addEventListener("mousemove", (e) => {
    const x = Math.min(e.clientX + 10, window.innerWidth - tip.offsetWidth - 8);
    tip.style.left = `${x}px`;
    tip.style.top = `${Math.max(4, e.clientY - 28)}px`;
  });
  document.addEventListener("mouseover", (e) => {
    const el = e.target.closest?.("[data-tooltip]");
    cur = el && el.dataset.tooltip ? el : null;
    tip.textContent = cur ? cur.dataset.tooltip : "";
    tip.style.opacity = cur ? "1" : "0";
  });
  document.addEventListener("mousedown", () => { tip.style.opacity = "0"; });
}

// keyboard: 1–6 tabs, Esc cancel, L legend, C position format
function initKeyboard() {
  const tabs = [...document.querySelectorAll("#toolbarTabs .tab-btn")];
  // capture phase + stopPropagation: handled shortcuts never reach Leaflet's own key handler
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === "Escape") {
      handled();
      if (!$("helpPanel").classList.contains("hidden")) return $("helpPanel").classList.add("hidden");
      cancelTool();
      return;
    }
    const t = e.target; // shortcuts are off only while typing in a field
    const typing = /^(SELECT|TEXTAREA)$/.test(t.tagName) || t.isContentEditable ||
      (t.tagName === "INPUT" && !/^(checkbox|radio|range|button)$/.test(t.type));
    if (typing) return;
    if (/^[1-6]$/.test(e.key)) { handled(); tabs[+e.key - 1]?.click(); }
    else if (e.key === "l" || e.key === "L") { handled(); toggleLegend(); }
    else if (e.key === "c" || e.key === "C") { handled(); cyclePosFmt(); }
    else if (e.key === "z" || e.key === "Z") { handled(); zoomToChartExtent(); }
    else if (e.key === "?") { handled(); $("helpPanel").classList.toggle("hidden"); }
  }, true);
  $("btnHelp").onclick = () => $("helpPanel").classList.toggle("hidden");
  $("btnHelpClose").onclick = () => $("helpPanel").classList.add("hidden");
  $("btnToolCancel").onclick = cancelTool;
}

/* ---------- status bar: position, scale, zoom, clock, iServer link ---------- */
const POS_FMTS = ["ddm", "dms", "dd", "utm"];
let posFmt = POS_FMTS.includes(store.get("posfmt")) ? store.get("posfmt") : "ddm";
let lastMouse = null;
let clockTick = () => {}; // set by initStatusBar()
function renderPos() {
  $("btnPosFmt").textContent = posFmt.toUpperCase();
  $("statusPos").textContent = lastMouse ? fmtPos(lastMouse, posFmt) : "–";
}
function cyclePosFmt() {
  posFmt = POS_FMTS[(POS_FMTS.indexOf(posFmt) + 1) % POS_FMTS.length];
  store.set("posfmt", posFmt);
  renderPos();
}
function renderScale() {
  const c = map.getCenter(), z = map.getZoom();
  const mpp = (40075016.686 * Math.cos((c.lat * Math.PI) / 180)) / Math.pow(2, z + 8); // metres per CSS pixel
  const denom = mpp / 0.00028; // OGC standard pixel 0.28 mm
  const nice = denom > 1000 ? Math.round(denom / 100) * 100 : Math.round(denom);
  $("statusScale").textContent = `1:${nice.toLocaleString("en-US")}`;
  $("statusZoom").textContent = `Z ${z}`;
}
function initStatusBar() {
  map.on("mousemove", (e) => { lastMouse = e.latlng; renderPos(); });
  map.on("zoomend moveend", renderScale);
  $("btnPosFmt").onclick = cyclePosFmt;
  renderPos();
  renderScale();
  clockTick = () => {
    const d = new Date();
    $("statusClock").textContent = timeFmt === "dtg"
      ? fmtDate(d, "dtg").replace(/ .*/, "")          // DDHHMMZ
      : `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}Z`;
  };
  clockTick();
  setInterval(() => clockTick(), 1000);
  checkServer(); // re-schedules itself (30 s online, 10 s offline)
}

let serverOk = null;
async function checkServer() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 5000);
  let ok = false;
  try {
    const r = await fetch(`${MAP_URL}.json`, { cache: "no-store", signal: ctl.signal });
    ok = r.ok;
  } catch { ok = false; }
  clearTimeout(t);
  const el = $("statusConn");
  el.classList.toggle("conn-ok", ok);
  el.classList.toggle("conn-bad", !ok);
  el.dataset.tooltip = ok ? "iServer reachable (checked every 30 s)" : "iServer NOT reachable – re-checking every 10 s";
  const was = serverOk;
  serverOk = ok;
  if (was !== null && ok !== was) {
    if (ok) {
      document.querySelectorAll(".toast.error").forEach((t) => t.remove()); // stale offline errors
      toast("iServer connection restored – reloading chart data.", "ok", 4000);
      recoverFromOffline();
    } else {
      toast("iServer is not reachable – check the network or the iServer service.", "error", 0, true);
    }
  } else if (was === null && !ok) {
    toast("iServer is not reachable – check MAP_URL in s100.config.js and the network.", "error", 0, true);
  }
  if (!ok && !subLayers.length) buildLayerList(); // show the offline message in the Layers tab
  updateExtentButtons();
  clearTimeout(checkServer.timer);
  checkServer.timer = setTimeout(checkServer, ok ? 30000 : 10000); // re-check faster while offline
}

// everything that failed while iServer was down is loaded again – no page reload needed
function recoverFromOffline() {
  loadSources(); // also reloads the extents
  if (!defaultChartSetting) initS100Settings();
  if (!wla.times.length) initWlaTimes();
  chartLayer.redraw();
  if (encLayer) encLayer.redraw();
}

/* ---------- legend (depth shades follow the current contour settings) ---------- */
function paramValue(type, id, fallback) {
  const el = $(pcDomId(type, id));
  const v = el ? el.value : defaultChartSetting?.contextParameters?.[type]?.[id];
  return v === undefined || v === null || v === "" ? fallback : v;
}
/* Legend colours per theme.
   DAY: exact values read from the S-102 legend swatches and tiles (iMaritimeEditor 2026 + iServer tiles,
        S102_PC_3.0.0, FourShades): drying #58af9c, 0–S #61b7ff, S–Safety #82caff, Safety–Deep #a7d9fb, >Deep #c9edff.
   DUSK: drying / 0–S / S–Safety sampled from an iServer DUSK tile print (#234c44 / #1e4165 / #1d3246);
        the two deep zones were not in that view and follow the same darkening (estimated).
   NIGHT: estimated from DUSK (~45 % luminance) – re-sample from a NIGHT tile when iServer is available.
   S-104 grid points are drawn #008000 in DAY and DUSK. */
const LEGEND_PALETTE = {
  day:   { dry: "#58af9c", z1: "#61b7ff", z2: "#82caff", z3: "#a7d9fb", z4: "#c9edff", s104: "#008000" },
  dusk:  { dry: "#234c44", z1: "#1e4165", z2: "#1d3246", z3: "#18283a", z4: "#121e2b", s104: "#008000" },
  night: { dry: "#10221e", z1: "#0d1d2d", z2: "#0d1620", z3: "#0b121a", z4: "#080d12", s104: "#003a00" }
};
function buildLegend() {
  const hasS102 = !defaultChartSetting || !!defaultChartSetting.contextParameters?.S102;
  const shallow = +paramValue("S102", "ShallowContour", 2);
  const safety = +paramValue("S102", "SafetyContour", 15);
  const deep = +paramValue("S102", "DeepContour", 30);
  const four = String(paramValue("S102", "FourShades", "TRUE")).toUpperCase() !== "FALSE";
  const P = LEGEND_PALETTE[theme];
  const row = (color, text) => `<div class="legend-row"><span class="legend-sw" style="background:${color}"></span><span>${text}</span></div>`;
  const dot = (color, text, ring) =>
    `<div class="legend-row"><span class="legend-dot" style="${ring ? `border:2px solid ${color}` : `background:${color}`}"></span><span>${text}</span></div>`;
  let html = "";
  if (hasS102) {
    html += `<div class="legend-sub">S-102 depth zones</div>` + row(P.dry, "Drying (above chart datum)");
    html += four
      ? row(P.z1, `0 – ${shallow} m`) + row(P.z2, `${shallow} – ${safety} m`) +
        row(P.z3, `${safety} – ${deep} m`) + row(P.z4, `&gt; ${deep} m`)
      : row(P.z2, `0 – ${safety} m`) + row(P.z4, `&gt; ${safety} m`);
    html += `<div class="legend-note">Safety contour ${safety} m (bold line). ${S100_SCHEME[theme]} colour scheme.</div>`;
  }
  html += `<div class="legend-sub">S-104 water level</div>` +
    dot(P.s104, "Water-level grid point") +
    dot(ov("hi"), "Nearest grid point to the click", true) +
    `<div class="legend-row"><span class="legend-line" style="border-color:${ov("hi")}"></span><span>Link click → grid point (m · °T)</span></div>` +
    `<div class="legend-note">Heights relative to chart datum, interpolated at the clicked point.</div>`;
  $("legendBody").innerHTML = html;
}
function toggleLegend(force) {
  const collapsed = typeof force === "boolean" ? force : !$("legend").classList.contains("collapsed");
  $("legend").classList.toggle("collapsed", collapsed);
  $("legendCaret").textContent = collapsed ? "▸" : "▾";
  store.set("legend", collapsed ? "min" : "open");
}
$("btnLegendToggle").onclick = () => toggleLegend();

/* ---------- safety banner + print ---------- */
function initBanner() {
  const b = CONFIG.SAFETY_BANNER;
  const def = "TRAINING / DEMONSTRATION – NOT FOR NAVIGATION · Sample data: NOAA Charleston";
  const text = b === false || b?.enabled === false ? "" : typeof b === "string" ? b : b?.text || def;
  $("safetyBanner").textContent = text;
  $("safetyBanner").classList.toggle("hidden", !text);
  setTimeout(() => map.invalidateSize(), 0);
}
// pinned depth-probe reading with its UKC verdict (OK / CAUTION / NO-GO) for the printout
function printProbeBlock() {
  const pr = probe.pinned && probe.result;
  if (!pr) return "";
  const pos = fmtPos(pr.latlng, "ddm");
  if (!pr.r) return `<div class="print-probe"><strong>Depth probe (pinned) ${pos}</strong> · no S-102 coverage</div>`;
  const u = pr.u, r = pr.r;
  const h = r.water - parseFloat(r.text.match(/Charted depth \(S-102\): (-?[\d.]+)/)?.[1] || 0);
  const water = r.tideApplied
    ? ` · Water level ${h >= 0 ? "+" : ""}${h.toFixed(2)} m @ ${fmtTime(pr.wlaTime)}` +
      ` (${S104_METHOD[r.s104?.method] || "S-104"}) · Actual depth ${r.water.toFixed(2)} m`
    : " · No tide applied (WLA off)";
  const charted = r.text.match(/Charted depth \(S-102\): (-?[\d.]+) m/)?.[1];
  return `<div class="print-probe"><strong>Depth probe (pinned) ${pos}</strong> · Charted depth ${charted} m${water}` +
    (u ? ` · Draft ${u.draft.toFixed(1)} m · Required UKC ${u.margin.toFixed(1)} m ` +
      `<span class="ukc-badge ${u.cls}">UKC ${u.ukc >= 0 ? "+" : ""}${u.ukc.toFixed(2)} m · ${u.word}</span>` : "") +
    `</div>`;
}
function printMap() {
  const c = map.getCenter();
  $("printInfo").innerHTML =
    `<h2>${CONFIG.APP_TITLE || "S-100 Chart Display"}</h2>` +
    `<div>Printed ${fmtDate(new Date())} · Centre ${fmtPos(c, "ddm")} · Scale ${$("statusScale").textContent}` +
    (wla.enabled ? ` · WLA ${fmtTime(wla.times[wla.idx])}` : "") + ` · Theme ${S100_SCHEME[theme]}</div>` +
    printProbeBlock();
  map.invalidateSize();
  setTimeout(() => window.print(), 300);
}
$("btnPrint").onclick = printMap;
window.addEventListener("afterprint", () => map.invalidateSize());

/* ============================================================
   START
============================================================ */
document.title = CONFIG.APP_TITLE;
initBanner();
initTabs();
initSidebar();
initTooltip();
initKeyboard();
initStatusBar();
setTheme(theme);
setTimeFmt(timeFmt);
if (store.get("legend") === "min") toggleLegend(true);
buildLegend();
buildBasemapList();
loadSources();
initS100Settings();
initWlaTimes();
