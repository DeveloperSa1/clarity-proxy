const express = require("express");

const app = express();

const { CLARITY_API_TOKEN, SHARED_SECRET, PORT = 3000 } = process.env;

if (!CLARITY_API_TOKEN) {
  console.error("ERROR: Missing CLARITY_API_TOKEN env var.");
}

const CLARITY_EXPORT_URL =
  "https://www.clarity.ms/export-data/api/v1/project-live-insights";

// Cache to avoid hitting Clarity export limits
const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

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

function requireApiKey(req, res, next) {
  if (!SHARED_SECRET) return next();
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

/**
 * Normalize URL for matching:
 * - keep origin + pathname only
 * - drop query string and hash
 * - decode pathname (best effort)
 * This makes Final URL match Clarity URLs with tracking params.
 */
function normalizeUrlForMatch(input) {
  if (!input) return "";
  const s = String(input).trim();
  if (!s) return "";

  try {
    const u = new URL(s);
    // normalize trailing slash
    let path = u.pathname || "/";
    // decode path if encoded (best effort)
    try { path = decodeURI(path); } catch (_) {}
    // remove trailing slash (except root)
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    return `${u.origin}${path}`;
  } catch {
    // If it's not a valid absolute URL, fallback to simple cleanup
    return s.split("?")[0].split("#")[0].replace(/\/$/, "");
  }
}

async function fetchClarityLiveInsights({ days = 3, dimension1 = "URL" }) {
  const safeDays = Math.min(Math.max(parseInt(days, 10) || 3, 1), 3);
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
 * Aggregates metrics for any row whose URL normalizes to the target.
 * NOTE: Clarity export field names vary by metric block; this is best-effort mapping.
 */
function aggregateByEntryUrl(exportJson, targetFinalUrl) {
  const targetNorm = normalizeUrlForMatch(targetFinalUrl);

  const out = {
    targetUrl: targetFinalUrl,
    normalizedTarget: targetNorm,
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

      if (!rowNorm || rowNorm !== targetNorm) continue;
      out.matchedRows += 1;

      // Traffic
      if (metricName === "Traffic") {
        out.sessions += asNumber(r.totalSessionCount ?? r.sessionCount ?? r.sessions);
        out.users += asNumber(r.distantUserCount ?? r.userCount ?? r.users);
      }

      // Rage clicks
      if (metricName === "Rage Click Count") {
        out.rageClicks += asNumber(r.rageClickCount ?? r.count ?? r.totalRageClickCount);
      }

      // Dead clicks
      if (metricName === "Dead Click Count") {
        out.deadClicks += asNumber(r.deadClickCount ?? r.count ?? r.totalDeadClickCount);
      }

      // Scroll depth block (best effort)
      if (metricName === "Scroll Depth") {
        out.scrolls += asNumber(r.scrollCount ?? r.count ?? r.totalScrollCount);
      }

      // Popular pages block may include clicks (best effort)
      if (metricName === "Popular Pages") {
        out.clicks += asNumber(r.clickCount ?? r.clicks ?? r.totalClickCount ?? r.count);
      }

      // Engagement time block (best effort)
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

/**
 * NEW: URL-based endpoint
 * GET /metrics?url=<finalUrl>&days=3
 */
app.get("/metrics", requireApiKey, async (req, res) => {
  const targetUrl = String(req.query.url || "").trim();
  const days = req.query.days || "3";

  if (!targetUrl) {
    return res.status(400).json({ error: "Missing query param: url" });
  }

  // Safety: prevent absurdly long URLs
  if (targetUrl.length > 2000) {
    return res.status(400).json({ error: "URL too long" });
  }

  try {
    const exportJson = await fetchClarityLiveInsights({ days, dimension1: "URL" });
    const agg = aggregateByEntryUrl(exportJson, targetUrl);
    res.json(agg);
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: "Upstream error", message: String(e.message || e) });
  }
});
app.get("/debug/urls", requireApiKey, async (req, res) => {
  const days = req.query.days || "3";
  try {
    const exportJson = await fetchClarityLiveInsights({ days, dimension1: "URL" });

    const samples = [];
    for (const block of Array.isArray(exportJson) ? exportJson : []) {
      const rows = Array.isArray(block.information) ? block.information : [];
      for (const r of rows) {
        const rowUrl = r.URL || r.Url || r.url;
        if (rowUrl && !samples.includes(String(rowUrl))) samples.push(String(rowUrl));
        if (samples.length >= 150) break;
      }
      if (samples.length >= 150) break;
    }

    res.json({ days: Number(days), sampleCount: samples.length, samples });
  } catch (e) {
    res.status(502).json({ error: "Upstream error", message: String(e.message || e) });
  }
});
app.get("/debug/token", (req, res) => {
  const t = process.env.CLARITY_API_TOKEN || "";
  res.json({
    hasToken: t.length > 0,
    tokenLength: t.length
  });
});
app.get("/debug/schema", requireApiKey, async (req, res) => {
  const days = req.query.days || "3";
  try {
    const exportJson = await fetchClarityLiveInsights({ days, dimension1: "URL" });

    const schema = (Array.isArray(exportJson) ? exportJson : []).map((block) => {
      const rows = Array.isArray(block.information) ? block.information : [];
      const sampleRow = rows[0] || {};
      return {
        metricName: block.metricName || null,
        sampleKeys: Object.keys(sampleRow).slice(0, 80) // limit
      };
    });

    res.json({ days: Number(days), blockCount: schema.length, schema });
  } catch (e) {
    res.status(502).json({ error: "Upstream error", message: String(e.message || e) });
  }
});


app.listen(PORT, () => console.log(`Running on port ${PORT}`));



