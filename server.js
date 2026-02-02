const express = require("express");
const app = express();

const { CLARITY_API_TOKEN, SHARED_SECRET, PORT = 3000 } = process.env;

const CLARITY_EXPORT_URL =
  "https://www.clarity.ms/export-data/api/v1/project-live-insights";

// Quota-safe cache: 1 fetch per (days + dimension set) per ~23h
const cache = new Map();

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Optional API key protection for your proxy
function requireApiKey(req, res, next) {
  if (!SHARED_SECRET) return next();
  const key = req.header("X-API-Key");
  if (!key || key !== SHARED_SECRET) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function num(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Normalize URL for matching: strip www, keep origin+decoded path, drop query/hash, strip trailing slash
function normalizeUrlForMatch(input) {
  if (!input) return "";
  const s = String(input).trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    let host = (u.hostname || "").toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);

    let path = u.pathname || "/";
    try { path = decodeURI(path); } catch (_) {}
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

    return `https://${host}${path}`;
  } catch {
    return s.split("?")[0].split("#")[0].replace(/\/$/, "");
  }
}

// Your schema uses "Url" field name
function rowUrl(r) {
  return r?.Url || r?.URL || r?.url || "";
}

// Fetch export with up to 3 dimensions
async function fetchClarityExport({ days = 3, d1 = "URL", d2 = null, d3 = null, force = false }) {
  const safeDays = Math.min(Math.max(parseInt(days, 10) || 3, 1), 3);

  const cacheKey = `FULL|${safeDays}|${d1}|${d2 || ""}|${d3 || ""}`;
  const now = Date.now();
  const TTL_MS = 23 * 60 * 60 * 1000;

  const cached = cache.get(cacheKey);
  if (!force && cached && cached.expiresAt > now) return cached.payload;

  const url = new URL(CLARITY_EXPORT_URL);
  url.searchParams.set("numOfDays", String(safeDays));
  url.searchParams.set("dimension1", d1);
  if (d2) url.searchParams.set("dimension2", d2);
  if (d3) url.searchParams.set("dimension3", d3);

  const resp = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${CLARITY_API_TOKEN || ""}`,
      "Content-Type": "application/json"
    }
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Clarity API error ${resp.status}: ${t.slice(0, 300)}`);
  }

  const json = await resp.json();
  cache.set(cacheKey, { expiresAt: now + TTL_MS, payload: json });
  return json;
}

function initGroup() {
  return {
    sessionsCount: 0,
    sessionsWithMetricPercentage: 0,
    sessionsWithoutMetricPercentage: 0,
    pagesViews: 0,
    subTotal: 0
  };
}

function addGroup(target, r) {
  target.sessionsCount += num(r.sessionsCount);
  target.sessionsWithMetricPercentage += num(r.sessionsWithMetricPercentage);
  target.sessionsWithoutMetricPercentage += num(r.sessionsWithoutMetricPercentage);
  target.pagesViews += num(r.pagesViews);
  target.subTotal += num(r.subTotal);
}

function createBaseOutput(targetFinalUrl) {
  return {
    targetUrl: targetFinalUrl,
    normalizedTarget: normalizeUrlForMatch(targetFinalUrl),
    matchedRows: 0,

    // Traffic
    totalSessionCount: 0,
    totalBotSessionCount: 0,
    distinctUserCount: 0,
    pagesPerSessionPercentage: 0,

    // EngagementTime
    totalTime: 0,
    activeTime: 0,

    // ScrollDepth
    averageScrollDepth: 0,

    // Groups
    RageClickCount: initGroup(),
    DeadClickCount: initGroup(),
    ExcessiveScroll: initGroup(),
    QuickbackClick: initGroup(),
    ScriptErrorCount: initGroup(),
    ErrorClickCount: initGroup(),

    // Computed
    avgSessionDurationSec: 0,
    activeTimePerSessionSec: 0
  };
}

// -------- Google Ads filter logic (NO GTM, historical) --------

// You can filter by Channel OR by Source+Medium.
// We'll support BOTH and accept if either indicates Google Ads.
function isPaidSearchChannel(channelValue) {
  const v = String(channelValue || "").toLowerCase().trim();
  if (!v) return false;

  // Common label
  if (v === "paid search") return true;

  // Looser matching
  if (v.includes("paid") && v.includes("search")) return true;
  if (v.includes("cpc") || v.includes("ppc")) return true;

  return false;
}

function isGoogleCpc(sourceValue, mediumValue) {
  const s = String(sourceValue || "").toLowerCase().trim();
  const m = String(mediumValue || "").toLowerCase().trim();

  // Common paid traffic signatures
  const sourceOk = (s === "google" || s.includes("google"));
  const mediumOk = (m === "cpc" || m === "ppc" || m.includes("cpc") || m.includes("ppc"));

  return sourceOk && mediumOk;
}

/**
 * Aggregate ALL schema metrics for a URL from exportJson, with optional filterFn(row) to include/exclude rows.
 * This works for:
 * - URL-only exports (filterFn = null)
 * - Channel+URL exports (filterFn checks Channel)
 * - Source+Medium+URL exports (filterFn checks Source/Medium)
 */
function aggregateAllMetricsFromExport(exportJson, targetFinalUrl, filterFn) {
  const out = createBaseOutput(targetFinalUrl);
  const normalizedTarget = out.normalizedTarget;

  let scrollDepthSum = 0, scrollDepthN = 0;
  let pagesPerSessionPctSum = 0, pagesPerSessionPctN = 0;

  for (const block of Array.isArray(exportJson) ? exportJson : []) {
    const metricName = String(block.metricName || "");
    const rows = Array.isArray(block.information) ? block.information : [];

    for (const r of rows) {
      if (filterFn && !filterFn(r)) continue;

      const u = rowUrl(r);
      const rn = normalizeUrlForMatch(u);
      if (!rn || rn !== normalizedTarget) continue;

      out.matchedRows += 1;

      if (metricName === "Traffic") {
        out.totalSessionCount += num(r.totalSessionCount);
        out.totalBotSessionCount += num(r.totalBotSessionCount);
        out.distinctUserCount += num(r.distinctUserCount);

        const p = num(r.pagesPerSessionPercentage);
        if (p) { pagesPerSessionPctSum += p; pagesPerSessionPctN += 1; }
      }

      if (metricName === "EngagementTime") {
        out.totalTime += num(r.totalTime);
        out.activeTime += num(r.activeTime);
      }

      if (metricName === "ScrollDepth") {
        const d = num(r.averageScrollDepth);
        if (d) { scrollDepthSum += d; scrollDepthN += 1; }
      }

      if (metricName === "RageClickCount") addGroup(out.RageClickCount, r);
      if (metricName === "DeadClickCount") addGroup(out.DeadClickCount, r);
      if (metricName === "ExcessiveScroll") addGroup(out.ExcessiveScroll, r);
      if (metricName === "QuickbackClick") addGroup(out.QuickbackClick, r);
      if (metricName === "ScriptErrorCount") addGroup(out.ScriptErrorCount, r);
      if (metricName === "ErrorClickCount") addGroup(out.ErrorClickCount, r);
    }
  }

  if (scrollDepthN > 0) out.averageScrollDepth = Math.round(scrollDepthSum / scrollDepthN);
  if (pagesPerSessionPctN > 0) out.pagesPerSessionPercentage = Math.round(pagesPerSessionPctSum / pagesPerSessionPctN);

  if (out.totalSessionCount > 0 && out.totalTime > 0) {
    out.avgSessionDurationSec = Math.round(out.totalTime / out.totalSessionCount);
  }
  if (out.totalSessionCount > 0 && out.activeTime > 0) {
    out.activeTimePerSessionSec = Math.round(out.activeTime / out.totalSessionCount);
  }

  return out;
}

/* ---------------- ROUTES ---------------- */

// Health
app.get("/", (req, res) => res.json({ ok: true, service: "clarity-proxy" }));

// Schema debug for URL-only export
app.get("/debug/schema", requireApiKey, async (req, res) => {
  const days = req.query.days || "3";
  try {
    const exportJson = await fetchClarityExport({ days, d1: "URL", force: true });
    const schema = (Array.isArray(exportJson) ? exportJson : []).map((block) => {
      const rows = Array.isArray(block.information) ? block.information : [];
      const sampleRow = rows[0] || {};
      return { metricName: block.metricName || null, sampleKeys: Object.keys(sampleRow).slice(0, 120) };
    });
    res.json({ days: Number(days), blockCount: schema.length, schema });
  } catch (e) {
    res.status(502).json({ error: "Upstream error", message: String(e.message || e) });
  }
});

// Refresh URL-only cache
app.get("/refresh", requireApiKey, async (req, res) => {
  const days = req.query.days || "3";
  try {
    const exportJson = await fetchClarityExport({ days, d1: "URL", force: true });
    res.json({ ok: true, days: Number(days), blocks: Array.isArray(exportJson) ? exportJson.length : 0 });
  } catch (e) {
    res.status(502).json({ error: "Upstream error", message: String(e.message || e) });
  }
});

// Refresh GoogleAds caches (Channel+URL and Source+Medium+URL) so you stay within quota predictably
app.get("/refresh-googleads", requireApiKey, async (req, res) => {
  const days = req.query.days || "3";
  try {
    // Two caches: one by Channel, one by Source/Medium. Both help.
    const a = await fetchClarityExport({ days, d1: "Channel", d2: "URL", force: true });
    const b = await fetchClarityExport({ days, d1: "Source", d2: "Medium", d3: "URL", force: true });

    res.json({
      ok: true,
      days: Number(days),
      blocks_channel_url: Array.isArray(a) ? a.length : 0,
      blocks_source_medium_url: Array.isArray(b) ? b.length : 0
    });
  } catch (e) {
    res.status(502).json({ error: "Upstream error", message: String(e.message || e) });
  }
});

// All traffic (no filter)
app.get("/metrics", requireApiKey, async (req, res) => {
  const targetUrl = String(req.query.url || "").trim();
  const days = req.query.days || "3";
  if (!targetUrl) return res.status(400).json({ error: "Missing query param: url" });

  try {
    const exportJson = await fetchClarityExport({ days, d1: "URL", force: false });
    res.json(aggregateAllMetricsFromExport(exportJson, targetUrl, null));
  } catch (e) {
    res.status(502).json({ error: "Upstream error", message: String(e.message || e) });
  }
});

// Google Ads only (historical) WITHOUT GTM
app.get("/metrics-googleads", requireApiKey, async (req, res) => {
  const targetUrl = String(req.query.url || "").trim();
  const days = req.query.days || "3";
  if (!targetUrl) return res.status(400).json({ error: "Missing query param: url" });

  try {
    // 1) Channel+URL
    const byChannel = await fetchClarityExport({ days, d1: "Channel", d2: "URL", force: false });
    const r1 = aggregateAllMetricsFromExport(byChannel, targetUrl, (row) => isPaidSearchChannel(row.Channel));

    // If Channel labeling fails, 2) Source+Medium+URL fallback
    if (r1.totalSessionCount > 0 || r1.matchedRows > 0) {
      return res.json({ mode: "channel_url_paid_search", ...r1 });
    }

    const bySourceMedium = await fetchClarityExport({ days, d1: "Source", d2: "Medium", d3: "URL", force: false });
    const r2 = aggregateAllMetricsFromExport(bySourceMedium, targetUrl, (row) =>
      isGoogleCpc(row.Source, row.Medium)
    );

    return res.json({ mode: "source_medium_url_google_cpc", ...r2 });
  } catch (e) {
    res.status(502).json({ error: "Upstream error", message: String(e.message || e) });
  }
});

app.listen(PORT, () => console.log(`Running on port ${PORT}`));


// const express = require("express");
// const app = express();

// const { CLARITY_API_TOKEN, SHARED_SECRET, PORT = 3000 } = process.env;

// const CLARITY_EXPORT_URL =
//   "https://www.clarity.ms/export-data/api/v1/project-live-insights";

// // Quota-safe cache (keep 23h so you never exceed 10/day)
// const cache = new Map();

// app.use((req, res, next) => {
//   res.setHeader("X-Content-Type-Options", "nosniff");
//   res.setHeader("X-Frame-Options", "DENY");
//   res.setHeader("Referrer-Policy", "no-referrer");
//   res.setHeader("Access-Control-Allow-Origin", "*");
//   res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
//   res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
//   if (req.method === "OPTIONS") return res.sendStatus(204);
//   next();
// });

// function requireApiKey(req, res, next) {
//   if (!SHARED_SECRET) return next();
//   const key = req.header("X-API-Key");
//   if (!key || key !== SHARED_SECRET) return res.status(401).json({ error: "Unauthorized" });
//   next();
// }

// function num(v) {
//   if (v === null || v === undefined) return 0;
//   if (typeof v === "number") return Number.isFinite(v) ? v : 0;
//   const n = Number(v);
//   return Number.isFinite(n) ? n : 0;
// }

// // Normalize URL for matching: strip www, keep origin + decoded path, drop query/hash, strip trailing slash
// function normalizeUrlForMatch(input) {
//   if (!input) return "";
//   const s = String(input).trim();
//   if (!s) return "";

//   try {
//     const u = new URL(s);
//     let host = (u.hostname || "").toLowerCase();
//     if (host.startsWith("www.")) host = host.slice(4);

//     let path = u.pathname || "/";
//     try { path = decodeURI(path); } catch (_) {}
//     if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

//     return `https://${host}${path}`;
//   } catch {
//     return s.split("?")[0].split("#")[0].replace(/\/$/, "");
//   }
// }

// // Your export schema uses "Url"
// function rowUrl(r) {
//   return r?.Url || r?.URL || r?.url || "";
// }

// // Fetch once/day-ish
// async function fetchClarityLiveInsights({ days = 3, dimension1 = "URL", force = false }) {
//   const safeDays = Math.min(Math.max(parseInt(days, 10) || 3, 1), 3);
//   const cacheKey = `FULL|${safeDays}|${dimension1}`;
//   const now = Date.now();
//   const TTL_MS = 23 * 60 * 60 * 1000;

//   const cached = cache.get(cacheKey);
//   if (!force && cached && cached.expiresAt > now) return cached.payload;

//   const url = new URL(CLARITY_EXPORT_URL);
//   url.searchParams.set("numOfDays", String(safeDays));
//   url.searchParams.set("dimension1", dimension1);

//   const resp = await fetch(url.toString(), {
//     method: "GET",
//     headers: {
//       Authorization: `Bearer ${CLARITY_API_TOKEN || ""}`,
//       "Content-Type": "application/json"
//     }
//   });

//   if (!resp.ok) {
//     const t = await resp.text().catch(() => "");
//     throw new Error(`Clarity API error ${resp.status}: ${t.slice(0, 300)}`);
//   }

//   const json = await resp.json();
//   cache.set(cacheKey, { expiresAt: now + TTL_MS, payload: json });
//   return json;
// }

// // Initialize an object for metric group results
// function initGroup() {
//   return {
//     sessionsCount: 0,
//     sessionsWithMetricPercentage: 0,
//     sessionsWithoutMetricPercentage: 0,
//     pagesViews: 0,
//     subTotal: 0
//   };
// }

// function addGroup(target, r) {
//   target.sessionsCount += num(r.sessionsCount);
//   target.sessionsWithMetricPercentage += num(r.sessionsWithMetricPercentage);
//   target.sessionsWithoutMetricPercentage += num(r.sessionsWithoutMetricPercentage);
//   target.pagesViews += num(r.pagesViews);
//   target.subTotal += num(r.subTotal);
// }

// function aggregateAllMetrics(exportJson, targetFinalUrl) {
//   const normalizedTarget = normalizeUrlForMatch(targetFinalUrl);

//   const out = {
//     targetUrl: targetFinalUrl,
//     normalizedTarget,
//     matchedRows: 0,

//     // Traffic
//     totalSessionCount: 0,
//     totalBotSessionCount: 0,
//     distinctUserCount: 0,
//     pagesPerSessionPercentage: 0,

//     // EngagementTime
//     totalTime: 0,
//     activeTime: 0,

//     // ScrollDepth
//     averageScrollDepth: 0,

//     // Groups
//     RageClickCount: initGroup(),
//     DeadClickCount: initGroup(),
//     ExcessiveScroll: initGroup(),
//     QuickbackClick: initGroup(),
//     ScriptErrorCount: initGroup(),
//     ErrorClickCount: initGroup(),

//     // Computed
//     avgSessionDurationSec: 0,
//     activeTimePerSessionSec: 0
//   };

//   // For averaging scroll depth and pagesPerSessionPercentage (these are averages, not totals)
//   let scrollDepthSum = 0, scrollDepthN = 0;
//   let pagesPerSessionPctSum = 0, pagesPerSessionPctN = 0;

//   for (const block of Array.isArray(exportJson) ? exportJson : []) {
//     const metricName = String(block.metricName || "");
//     const rows = Array.isArray(block.information) ? block.information : [];

//     for (const r of rows) {
//       const u = rowUrl(r);
//       const rn = normalizeUrlForMatch(u);
//       if (!rn || rn !== normalizedTarget) continue;

//       out.matchedRows += 1;

//       if (metricName === "Traffic") {
//         out.totalSessionCount += num(r.totalSessionCount);
//         out.totalBotSessionCount += num(r.totalBotSessionCount);
//         out.distinctUserCount += num(r.distinctUserCount);

//         const p = num(r.pagesPerSessionPercentage);
//         if (p) { pagesPerSessionPctSum += p; pagesPerSessionPctN += 1; }
//       }

//       if (metricName === "EngagementTime") {
//         out.totalTime += num(r.totalTime);
//         out.activeTime += num(r.activeTime);
//       }

//       if (metricName === "ScrollDepth") {
//         const d = num(r.averageScrollDepth);
//         if (d) { scrollDepthSum += d; scrollDepthN += 1; }
//       }

//       if (metricName === "RageClickCount") addGroup(out.RageClickCount, r);
//       if (metricName === "DeadClickCount") addGroup(out.DeadClickCount, r);
//       if (metricName === "ExcessiveScroll") addGroup(out.ExcessiveScroll, r);
//       if (metricName === "QuickbackClick") addGroup(out.QuickbackClick, r);
//       if (metricName === "ScriptErrorCount") addGroup(out.ScriptErrorCount, r);
//       if (metricName === "ErrorClickCount") addGroup(out.ErrorClickCount, r);
//     }
//   }

//   if (scrollDepthN > 0) out.averageScrollDepth = Math.round(scrollDepthSum / scrollDepthN);
//   if (pagesPerSessionPctN > 0) out.pagesPerSessionPercentage = Math.round(pagesPerSessionPctSum / pagesPerSessionPctN);

//   // Compute averages (seconds per session)
//   if (out.totalSessionCount > 0 && out.totalTime > 0) {
//     out.avgSessionDurationSec = Math.round(out.totalTime / out.totalSessionCount);
//   }
//   if (out.totalSessionCount > 0 && out.activeTime > 0) {
//     out.activeTimePerSessionSec = Math.round(out.activeTime / out.totalSessionCount);
//   }

//   return out;
// }

// /* -------- Routes -------- */

// app.get("/", (req, res) => res.json({ ok: true, service: "clarity-proxy" }));

// app.get("/debug/schema", requireApiKey, async (req, res) => {
//   const days = req.query.days || "3";
//   try {
//     const exportJson = await fetchClarityLiveInsights({ days, dimension1: "URL", force: true });
//     const schema = (Array.isArray(exportJson) ? exportJson : []).map((block) => {
//       const rows = Array.isArray(block.information) ? block.information : [];
//       const sampleRow = rows[0] || {};
//       return { metricName: block.metricName || null, sampleKeys: Object.keys(sampleRow).slice(0, 120) };
//     });
//     res.json({ days: Number(days), blockCount: schema.length, schema });
//   } catch (e) {
//     res.status(502).json({ error: "Upstream error", message: String(e.message || e) });
//   }
// });

// // Manual refresh (1 Clarity call; cached 23h)
// app.get("/refresh", requireApiKey, async (req, res) => {
//   const days = req.query.days || "3";
//   try {
//     const exportJson = await fetchClarityLiveInsights({ days, dimension1: "URL", force: true });
//     res.json({ ok: true, days: Number(days), blocks: Array.isArray(exportJson) ? exportJson.length : 0 });
//   } catch (e) {
//     res.status(502).json({ error: "Upstream error", message: String(e.message || e) });
//   }
// });

// // Main endpoint: returns EVERYTHING we can extract
// app.get("/metrics", requireApiKey, async (req, res) => {
//   const targetUrl = String(req.query.url || "").trim();
//   const days = req.query.days || "3";
//   if (!targetUrl) return res.status(400).json({ error: "Missing query param: url" });

//   try {
//     const exportJson = await fetchClarityLiveInsights({ days, dimension1: "URL", force: false });
//     res.json(aggregateAllMetrics(exportJson, targetUrl));
//   } catch (e) {
//     res.status(502).json({ error: "Upstream error", message: String(e.message || e) });
//   }
// });

// app.listen(PORT, () => console.log(`Running on port ${PORT}`));

