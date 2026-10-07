/* ============================================================
   S-100 CHART DISPLAY – CONFIGURATION
   Edit this file only. Everything else reads from here.
============================================================ */
export const CONFIG = {
  /* ---------- iServer 2026 services (Chart service extension module required) ----------
     REQUIRED: point these at your own SuperMap iServer. The service names below are the
     ones used for the NOAA Charleston sample data (see README > Data). 
     MAP_URL  : REST map service of the chart map (no query string!)
     DATA_URL : REST data service of the same workspace (needed for S-102 depth query
                and S-104 tide query) */
  /* Optional S-57 ENC base chart published as a SEPARATE map (S-52 portrayal).
     Keep S-57 out of the S-100 map: when a map mixes S-57 and S-100, iServer returns an
     S-57 chartSetting and the S-100 settings / WLA are not available. Leave "" to disable. */
  ENC_MAP_URL: "http://localhost:8090/iserver/services/map-NOAA_S100/rest/maps/Charleston_ENC",

  MAP_URL: "http://localhost:8090/iserver/services/map-NOAA_S100/rest/maps/Charleston_S100",
  DATA_URL: "http://localhost:8090/iserver/services/data-NOAA_S100/rest/data",

  /* ---------- Initial view (Charleston harbour entrance) ---------- */
  CENTER: [32.72, -79.85],
  ZOOM: 12,

  /* ---------- S-102 depth query ----------
     getChartWaterDepth() queries the S-102 grid datasets (names ending in _D / _U) with X/Y
     in the dataset's own coordinate system. NOAA S-102 is UTM zone 17N, so the app converts
     the clicked lon/lat to UTM before the query. Set type: "geographic" if your S-102 is in WGS 84. */
  S102_CRS: { type: "utm", zone: 17, south: false }, // e.g. Jakarta Bay: { type: "utm", zone: 48, south: true }

  /* ---------- S-104 water level (tide) ----------
     Datasource name as published in the DATA service, and the dataset names inside it.
     Defaults below are iClient's defaults. CHECK the real names in:
     <DATA_URL>/datasources/<S104_DATASOURCE>/datasets.json */
  S104_DATASOURCE: "S100",
  S104_POSITION_DATASET: "S104Position4326", // point dataset, must be in WGS 84 (lon/lat)
  S104_WATERLEVEL_DATASET: "S104WaterLevel",
  S104_TIME_DATASET: "S104Time",
  S104_TIME_ID_KEY: "TIMEID",
  S104_CELL_ID_KEY: "CELLID",

  /* ---------- UI ---------- */
  APP_TITLE: "S-100 Chart Display",
  WLA_PLAY_INTERVAL_MS: 1500, // animation speed of the water-level playback

  /* Banner at the top of the page. Set enabled:false (or SAFETY_BANNER: false) to hide it. */
  SAFETY_BANNER: {
    enabled: true,
    text: "TRAINING / DEMONSTRATION – NOT FOR NAVIGATION · Sample data: NOAA Charleston"
  },

  /* Depth probe: default vessel draft and required under-keel clearance (metres).
     UKC = depth (+ S-104 water level when WLA is on) − draft
     OK ≥ margin · CAUTION 0 … margin · NO-GO < 0. Users can change both in the panel. */
  VESSEL_DRAFT_M: 5.0,
  UKC_MARGIN_M: 1.0
};
