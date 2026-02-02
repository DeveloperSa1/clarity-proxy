const express = require("express");
const app = express();

const { CLARITY_API_TOKEN, SHARED_SECRET, PORT = 3000 } = process.env;

const CLARITY_EXPORT_URL =
  "https://www.clarity.ms/export-data/api/v1/project-live-insights";

const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Basic headers
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

// Optional API key auth (recommended)
function requireApiKey(req, res, next) {
  if (!SHARED_SECRET) return next();
  const key = req.header("X-API-Key");
  if (!key || key !== SHARED_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function asNumber(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Normalize URL for matching:
 * - normalize host (strip www)
 * - keep origin + decoded pathname
 * - drop query/hash
 * - remove trailing slash (except root)
 */
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
    // fallback if not absolute URL
    return s.split("?")[0].split("#")[0].replace(/\/$/, "");
  }
}

async function fetchClarityLiveInsights({ days = 3, dimension1 = "URL" }) {
  const safeDays = Math.min(Math.max(parseInt(days, 10) || 3, 1), 3); // Clarity supports 1-3
  const cacheKey = `${safeDays}|${dimension1}`;
  const now = Date.now();

  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.payload;

  const url = new URL(CLARITY_EXPORT_URL);
  url.searchParams.set("numOfDays", String(safeDays));
  url.searchParams.set("dimension1", dimension1);

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
  cache.set(cacheKey, { expiresAt: now + CACHE_TTL_MS, payload: json });
  return json;
}

function metricNameHas(metricName, phrase) {
  return String(metricName || "").toLowerCase().includes(String(phrase).toLowerCase());
}

/**
 * Pick numeric field from row using multiple candidate names.
 * Prefers first non-zero if available, else first present.
 */
function pickNumber(obj, keys) {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k)) {
      const n = asNumber(obj[k]);
      if (Number.isFinite(n) && n !== 0) return n;
    }
  }
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k)) return asNumber(obj[k]);
  }
  return 0;
}

/**
 * Aggregate metrics for rows whose normalized URL matches target normalized URL.
 * Works even if Clarity returns extra query params (gclid, gbraid, etc.).
 */
function aggregateByEntryUrl(exportJson, targetFinalUrl) {
  const normalizedTarget = normalizeUrlForMatch(targetFinalUrl);

  const out = {
    targetUrl: targetFinalUrl,
    normalizedTarget,
    matchedRows: 0,
    sessions: 0,
    users: 0,
    engagedSessions: 0,
    clicks: 0,
    scrolls: 0,
    rageClicks: 0,
    deadClicks: 0,
    avgSessionDuration: 0
  };

  let durationSum = 0;
  let durationCount = 0;

  for (const block of Array.isArray(exportJson) ? exportJson : []) {
    const metricName = String(block.metricName || "");
    const rows = Array.isArray(block.information) ? block.information : [];

    for (const r of rows) {
      const rowUrl = r.URL || r.Url || r.url;
      const rowNorm = normalizeUrlForMatch(rowUrl);

      if (!rowNorm || rowNorm !== normalizedTarget) continue;
      out.matchedRows += 1;

      // ---- Sessions / Users ----
      if (metricNameHas(metricName, "traffic")) {
        out.sessions += pickNumber(r, [
          "totalSessionCount", "sessionCount", "sessions", "totalSessions"
        ]);
        out.users += pickNumber(r, [
          "distantUserCount", "distinctUserCount", "uniqueUsers", "userCount", "users", "totalUsers"
        ]);
      }

      // ---- Engagement + Duration ----
      if (metricNameHas(metricName, "engagement")) {
        out.engagedSessions += pickNumber(r, [
          "engagedSessionCount", "engagedSessions", "totalEngagedSessions", "count"
        ]);

        const avgDur = pickNumber(r, [
          "avgSessionDuration", "averageSessionDuration", "avgDurationSeconds",
          "avgDuration", "sessionDuration", "durationSeconds"
        ]);
        if (avgDur > 0) {
          durationSum += avgDur;
          durationCount += 1;
        }
      }

      // ---- Clicks ----
      if (metricNameHas(metricName, "click") || metricNameHas(metricName, "popular")) {
        out.clicks += pickNumber(r, [
          "clickCount", "clicks", "totalClickCount", "totalClicks", "count"
        ]);
      }

      // ---- Scrolls ----
      if (metricNameHas(metricName, "scroll")) {
        out.scrolls += pickNumber(r, [
          "scrollCount", "scrolls", "totalScrollCount", "totalScrolls", "count"
        ]);
      }

      // ---- Rage clicks ----
      if (metricNameHas(metricName, "rage")) {
        out.rageClicks += pickNumber(r, [
          "rageClickCount", "rageClicks", "totalRageClickCount", "count"
        ]);
      }

      // ---- Dead clicks ----
      if (metricNameHas(metricName, "dead")) {
        out.deadClicks += pickNumber(r, [
          "deadClickCount", "deadClicks", "totalDeadClickCount", "count"
        ]);
      }

      // ---- Fallback: sometimes duration is in a different metric block ----
      // If the metricName includes duration/time and has avg duration fields
      if (metricNameHas(metricName, "duration") || metricNameHas(metricName, "time")) {
        const avgDur = pickNumber(r, [
          "avgSessionDuration", "averageSessionDuration", "avgDurationSeconds",
          "avgDuration", "sessionDuration", "durationSeconds"
        ]);
        if (avgDur > 0) {
          durationSum += avgDur;
          durationCount += 1;
        }
      }
    }
  }

  if (durationCount > 0) out.avgSessionDuration = Math.round(durationSum / durationCount);
  return out;
}

/* ------------------ ROUTES ------------------ */

// Health
app.get("/", (req, res) => {
  res.json({ ok: true, service: "clarity-proxy" });
});

// Confirm env loaded
app.get("/debug/token", (req, res) => {
  const t = process.env.CLARITY_API_TOKEN || "";
  res.json({ hasToken: t.length > 0, tokenLength: t.length });
});

// Schema debug: shows metric blocks + sample keys (so you can tune mapping if needed)
app.get("/debug/schema", requireApiKey, async (req, res) => {
  const days = req.query.days || "3";
  try {
    const exportJson = await fetchClarityLiveInsights({ days, dimension1: "URL" });

    const schema = (Array.isArray(exportJson) ? exportJson : []).map((block) => {
      const rows = Array.isArray(block.information) ? block.information : [];
      const sampleRow = rows[0] || {};
      return {
        metricName: block.metricName || null,
        sampleKeys: Object.keys(sampleRow).slice(0, 120)
      };
    });

    res.json({ days: Number(days), blockCount: schema.length, schema });
  } catch (e) {
    res.status(502).json({ error: "Upstream error", message: String(e.message || e) });
  }
});

// NEW main endpoint for URL-based lookup
// GET /metrics?url=<finalUrl>&days=3
app.get("/metrics", requireApiKey, async (req, res) => {
  const targetUrl = String(req.query.url || "").trim();
  const days = req.query.days || "3";

  if (!targetUrl) return res.status(400).json({ error: "Missing query param: url" });
  if (targetUrl.length > 2000) return res.status(400).json({ error: "URL too long" });

  try {
    const exportJson = await fetchClarityLiveInsights({ days, dimension1: "URL" });
    const agg = aggregateByEntryUrl(exportJson, targetUrl);
    res.json(agg);
  } catch (e) {
    res.status(502).json({ error: "Upstream error", message: String(e.message || e) });
  }
});

app.listen(PORT, () => console.log(`Running on port ${PORT}`));
