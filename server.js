const express = require("express");

const app = express();

// ENV VARS (set in Railway):
// - CLARITY_API_TOKEN (required)
// - SHARED_SECRET (recommended)
// - PORT (provided by host)
const { CLARITY_API_TOKEN, SHARED_SECRET, PORT = 3000 } = process.env;

if (!CLARITY_API_TOKEN) {
  console.error("ERROR: Missing CLARITY_API_TOKEN env var.");
}

// Export endpoint base
const CLARITY_EXPORT_URL =
  "https://www.clarity.ms/export-data/api/v1/project-live-insights";

// Simple in-memory cache (keyed by days + dimension)
const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Basic headers + OPTIONS
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
  if (!SHARED_SECRET) return next(); // if not set, endpoint is public
  const key = req.header("X-API-Key");
  if (!key || key !== SHARED_SECRET) return res.status(401).json({ error: "Unauthorized" });
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

// Detect adgroup_id from URL row
function urlHasAdgroupId(urlValue, adgroupId) {
  if (!urlValue || !adgroupId) return false;

  const idStr = String(adgroupId);

  try {
    const u = new URL(String(urlValue));
    return (u.searchParams.get("adgroup_id") || "") === idStr;
  } catch {
    // Fallback if it's not a full URL
    const s = String(urlValue);
    return s.includes(`adgroup_id=${encodeURIComponent(idStr)}`) || s.includes(`adgroup_id=${idStr}`);
  }
}

async function fetchClarityLiveInsights({ days = 3, dimension1 = "URL" }) {
  const safeDays = Math.min(Math.max(parseInt(days, 10) || 3, 1), 3); // Clarity supports 1-3 days
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
      Authorization: `Bearer ${CLARITY_API_TOKEN}`,
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

/**
 * Clarity export returns an array of metric blocks:
 * [
 *   { metricName: "Traffic", information: [ ... rows ... ] },
 *   { metricName: "Rage Click Count", information: [ ... ] },
 *   ...
 * ]
 *
 * Each row includes the dimension value (URL) and metric fields.
 * Field names can vary; we use resilient detection.
 */
function aggregateByAdgroup(exportJson, adgroupId) {
  const out = {
    adgroup_id: String(adgroupId),
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
      if (!urlHasAdgroupId(rowUrl, adgroupId)) continue;

      // Traffic block commonly contains sessions + users
      if (metricName === "Traffic") {
        out.sessions += asNumber(r.totalSessionCount ?? r.sessionCount ?? r.sessions);
        out.users += asNumber(r.distantUserCount ?? r.userCount ?? r.users);
      }

      if (metricName === "Rage Click Count") {
        out.rageClicks += asNumber(r.rageClickCount ?? r.count ?? r.totalRageClickCount);
      }

      if (metricName === "Dead Click Count") {
        out.deadClicks += asNumber(r.deadClickCount ?? r.count ?? r.totalDeadClickCount);
      }

      // Scrolls can come from scroll-related blocks; this is best-effort
      if (metricName === "Scroll Depth") {
        out.scrolls += asNumber(r.scrollCount ?? r.count ?? r.totalScrollCount);
      }

      // Clicks may appear in Popular Pages or similar blocks; best-effort
      if (metricName === "Popular Pages") {
        out.clicks += asNumber(r.clickCount ?? r.clicks ?? r.totalClickCount ?? r.count);
      }

      // Engagement Time: best-effort engaged sessions + duration
      if (metricName === "Engagement Time") {
        out.engagedSessions += asNumber(r.engagedSessionCount ?? r.engagedSessions ?? r.count);

        const avgDur =
          asNumber(r.avgSessionDuration ?? r.averageSessionDuration ?? r.avgDurationSeconds);

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

// Health check
app.get("/", (req, res) => {
  res.json({ ok: true, service: "clarity-proxy" });
});

// Main endpoint
app.get("/adgroup/:id", requireApiKey, async (req, res) => {
  const adgroupId = req.params.id;
  const days = req.query.days || "3"; // default 3

  try {
    const exportJson = await fetchClarityLiveInsights({ days, dimension1: "URL" });
    const agg = aggregateByAdgroup(exportJson, adgroupId);
    res.json(agg);
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: "Upstream error", message: String(e.message || e) });
  }
});

app.listen(PORT, () => console.log(`Running on port ${PORT}`));
