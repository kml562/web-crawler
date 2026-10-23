import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";
import type { Response } from "express";
import type { ApplicationResult } from "./types/index.js";
import { loadJobsConfig } from "./config/index.js";
import { closeBrowser } from "./crawler/browser.js";
import { LinkedInScraper } from "./jobs/linkedin.js";
import { IndeedScraper } from "./jobs/indeed.js";
import { WellfoundScraper } from "./jobs/wellfound.js";
import { WeWorkRemotelyScraper } from "./jobs/weworkremotely.js";
import { GreenhouseScraper } from "./jobs/greenhouse.js";
import { LeverScraper } from "./jobs/lever.js";
import { NaukriScraper } from "./jobs/naukri.js";

import { appendResult, loadApplied } from "./tracker/storage.js";
import { listCareerPages, countCareerPages } from "./tracker/careerPages.js";
import { NaukriRecorder, FLOW_PATH } from "./jobs/naukriRecorder.js";
import { loadFlow } from "./jobs/naukriReplayer.js";
import { connectDB } from "./db/connect.js";
import { CrawlRun } from "./db/models/CrawlRun.js";
import { SystemLog } from "./db/models/SystemLog.js";
import { logger } from "./utils/logger.js";
import type { BaseScraper } from "./crawler/base.js";
import { getAuthStatus, loginWithBrowser, disconnect, isConnected } from "./auth/loginManager.js";
import type { AuthSource } from "./auth/loginManager.js";
import { loadProfile, saveProfile, RESUME_PATH } from "./utils/profile.js";
import { extractProfileFromPDF } from "./utils/resumeParser.js";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const PORT = process.env["PORT"] ?? 3000;

app.use(cors());
app.use(express.json());

// ── HTTP request logging ─────────────────────────────────
app.use((req, _res, next) => {
  if (!req.path.startsWith("/api/events")) { // skip SSE noise
    logger.debug(`${req.method} ${req.path}`, { service: "http" });
  }
  next();
});

// ── app-level password guard ─────────────────────────────
const APP_PASSWORD = process.env["APP_PASSWORD"];

app.post("/api/auth/app-login", (req, res) => {
  const { password } = req.body as { password: string };
  if (!APP_PASSWORD) { res.json({ ok: true }); return; }
  if (password === APP_PASSWORD) res.json({ ok: true });
  else res.status(401).json({ error: "Wrong password" });
});

app.get("/api/auth/app-check", (_req, res) => {
  res.json({ passwordRequired: !!APP_PASSWORD });
});

app.use(express.static(path.resolve("public")));

// ── SSE client registry ──────────────────────────────────
const sseClients = new Set<Response>();

function broadcast(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

// ── crawl state ──────────────────────────────────────────
let crawlRunning = false;

// ── URL → source mapping ─────────────────────────────────
const SOURCE_MAP: Record<string, string> = {
  "linkedin.com":        "linkedin",
  "indeed.com":          "indeed",
  "naukri.com":          "naukri",
  "wellfound.com":       "wellfound",
  "angel.co":            "wellfound",
  "weworkremotely.com":  "weworkremotely",
  "greenhouse.io":       "greenhouse",
  "lever.co":            "lever",
};

function detectSource(input: string): string | null {
  const lower = input.toLowerCase();
  for (const [domain, source] of Object.entries(SOURCE_MAP)) {
    if (lower.includes(domain)) return source;
  }
  // also accept direct source names
  const direct = ["linkedin","indeed","naukri","wellfound","weworkremotely","greenhouse","lever"];
  if (direct.includes(lower.trim())) return lower.trim();
  return null;
}

function scraperForSource(source: string, cfg: ReturnType<typeof loadJobsConfig>): BaseScraper | null {
  switch (source) {
    case "linkedin":       return new LinkedInScraper(cfg);
    case "indeed":         return new IndeedScraper(cfg);
    case "naukri":         return new NaukriScraper(cfg);
    case "wellfound":      return new WellfoundScraper(cfg);
    case "weworkremotely": return new WeWorkRemotelyScraper(cfg);
    case "greenhouse":     return new GreenhouseScraper(cfg);
    case "lever":          return new LeverScraper(cfg);
    default:               return null;
  }
}

// ── helpers ──────────────────────────────────────────────
function buildStats(results: ApplicationResult[]) {
  const byStatus = { applied: 0, skipped: 0, failed: 0, already_applied: 0 };
  const bySource: Record<string, number> = {};
  const byDate: Record<string, number> = {};
  for (const r of results) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    bySource[r.job.source] = (bySource[r.job.source] ?? 0) + 1;
    const date = (r.appliedAt ?? r.job.foundAt ?? "").slice(0, 10);
    if (date) byDate[date] = (byDate[date] ?? 0) + 1;
  }
  return {
    total: results.length, byStatus, bySource, byDate,
    all: results.map((r) => ({
      title: r.job.title, company: r.job.company, source: r.job.source,
      location: r.job.location, url: r.job.url,
      appliedAt: r.appliedAt ?? r.job.foundAt, status: r.status, error: r.error,
    })),
  };
}

// ── SSE endpoint ─────────────────────────────────────────
app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

// ── start crawl ──────────────────────────────────────────
app.post("/api/crawl", (req, res) => {
  const { site, autoApply, showBrowser } = req.body as { site: string; autoApply: boolean; showBrowser?: boolean };

  const source = detectSource(site ?? "");
  if (!source) {
    res.status(400).json({ error: `Unknown site "${site}". Supported: LinkedIn, Indeed, Naukri, Wellfound, WeWorkRemotely, Greenhouse, Lever` });
    return;
  }
  if (crawlRunning) {
    res.status(409).json({ error: "A crawl is already running. Wait for it to finish." });
    return;
  }

  res.json({ ok: true, source });

  // run async — updates go via SSE
  crawlRunning = true;
  broadcast("status", { running: true, source });

  (async () => {
    const runStart = Date.now();
    const run = await CrawlRun.create({
      source, startedAt: new Date().toISOString(),
      autoApply: typeof autoApply === "boolean" ? autoApply : false,
      status: "running",
    });

    const addLog = (level: "info" | "warn" | "error", msg: string) => {
      run.logs.push({ time: new Date().toISOString(), level, msg });
      broadcast("log", { msg, level });
      logger[level](msg, { service: source, runId: String(run._id) });
    };

    const addFailure = (jobTitle: string, company: string, reason: string, url: string) => {
      run.failureReasons.push({ jobTitle, company, reason, url });
      addLog("warn", `⚠ Skipped "${jobTitle}" @ ${company} — ${reason}`);
    };

    try {
      const cfg = loadJobsConfig();
      if (typeof autoApply === "boolean") cfg.autoApply = autoApply;
      if (typeof showBrowser === "boolean") cfg.showBrowser = showBrowser;

      const scraper = scraperForSource(source, cfg);
      if (!scraper) throw new Error(`No scraper for ${source}`);

      // Route all scraper-internal logs to SSE so they appear in the UI
      scraper.setLogCallback((msg) => addLog("info", msg));

      // Guard: sources that need a browser login must be connected first
      const noLoginNeeded = ["greenhouse", "lever", "weworkremotely"];
      if (!noLoginNeeded.includes(source) && !isConnected(source)) {
        throw new Error(`${source} is not connected. Go to the Profile tab → Accounts and click "Connect" next to ${source} first.`);
      }

      addLog("info", `Starting ${source} crawler…`);
      await scraper.init();

      addLog("info", "Fetching job listings…");
      const jobs = await scraper.fetchListings();

      // Extraction stats
      run.jobsRaw      = jobs.length;   // already filtered in scraper, still useful
      run.jobsFiltered = jobs.length;
      run.totalFound   = jobs.length;
      run.pagesVisited = scraper.pagesVisited || Math.max(1, Math.ceil(jobs.length / 10));

      addLog("info", `Found ${jobs.length} jobs (pages visited: ${run.pagesVisited})`);
      broadcast("jobs", { count: jobs.length });

      let applied = 0;
      for (const job of jobs) {
        if (applied >= cfg.maxApplicationsPerRun) {
          addLog("info", `Reached max applications limit (${cfg.maxApplicationsPerRun})`);
          break;
        }

        let resultStatus: string = "skipped";
        let resultError: string | undefined;

        if (cfg.autoApply) {
          addLog("info", `Applying: ${job.title} @ ${job.company}`);
          const result = await scraper.applyToJob(job);
          await appendResult(result);
          resultStatus = result.status;
          resultError  = result.error;

          if (result.status === "applied") {
            applied++; run.applied++;
            addLog("info", `✓ Applied: ${job.title} @ ${job.company}`);
          } else if (result.status === "skipped") {
            run.skipped++;
            addFailure(job.title, job.company, result.error ?? "No easy-apply / external ATS", job.url);
          } else if (result.status === "failed") {
            run.failed++;
            addFailure(job.title, job.company, result.error ?? "Unknown error", job.url);
            addLog("error", `✗ Failed: ${job.title} — ${result.error ?? "unknown"}`);
          } else if (result.status === "already_applied") {
            run.alreadyApplied++;
            addLog("info", `Already applied: ${job.title}`);
          }
          broadcast("progress", { job: job.title, company: job.company, status: result.status, error: result.error });
        } else {
          await appendResult({ job, status: "skipped" });
          run.skipped++;
          broadcast("progress", { job: job.title, company: job.company, status: "skipped" });
        }

        // Snapshot every job for the detail view
        run.jobSnapshot.push({
          title:    job.title,
          company:  job.company,
          location: job.location,
          url:      job.url,
          status:   resultStatus,
          ...(resultError ? { error: resultError } : {}),
        });
      }

      await scraper.close();
      await closeBrowser();

      run.status    = "done";
      run.finishedAt = new Date().toISOString();
      run.durationMs = Date.now() - runStart;
      await run.save();

      const stats = buildStats(await loadApplied());
      broadcast("done", { applied, total: jobs.length, stats });
      addLog("info", `Done in ${(run.durationMs / 1000).toFixed(1)}s — Applied: ${applied}/${jobs.length} | Skipped: ${run.skipped} | Failed: ${run.failed}`);

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      run.status = "error";
      run.errorMessage = msg;
      run.finishedAt = new Date().toISOString();
      run.durationMs = Date.now() - runStart;
      await run.save();
      broadcast("error", { msg });
      addLog("error", `Fatal error: ${msg}`);
      logger.error(`Crawl failed [${source}]: ${msg}`, err, { service: source });
    } finally {
      await run.save().catch(() => {});
      crawlRunning = false;
      broadcast("status", { running: false });
    }
  })();
});

// ── upload JSON (import old data into DB) ────────────────
app.post("/api/upload", upload.single("file"), async (req, res) => {
  if (!req.file) { res.status(400).json({ error: "No file uploaded" }); return; }
  try {
    const results = JSON.parse(req.file.buffer.toString("utf-8")) as ApplicationResult[];
    for (const r of results) await appendResult(r);
    res.json({ ok: true, count: results.length });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Parse error" });
  }
});

// ── stats ────────────────────────────────────────────────
app.get("/api/stats", async (_req, res) => {
  res.json(buildStats(await loadApplied()));
});

app.get("/api/crawl/status", (_req, res) => {
  res.json({ running: crawlRunning });
});

// ── naukri performance ───────────────────────────────────
let naukriPerfCache: { data: Record<string, unknown>; ts: number } | null = null;

app.get("/api/naukri/performance", async (_req, res) => {
  // Cache 15 min to avoid hammering Naukri
  if (naukriPerfCache && Date.now() - naukriPerfCache.ts < 15 * 60 * 1000) {
    res.json(naukriPerfCache.data); return;
  }
  try {
    const cfg = loadJobsConfig();
    const scraper = new NaukriScraper(cfg);
    (scraper as unknown as { loadSession: () => void })["loadSession"]?.();
    // call private method via cast
    const data = await (scraper as unknown as { fetchPerformanceStats: () => Promise<Record<string, unknown>> }).fetchPerformanceStats();
    naukriPerfCache = { data, ts: Date.now() };
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

// ── crawl run history ─────────────────────────────────────
app.get("/api/career-pages", (_req, res) => {
  res.json({ count: countCareerPages(), pages: listCareerPages() });
});

// ── Naukri Learn Mode ────────────────────────────────────
let recorder: NaukriRecorder | null = null;
const learnSteps: string[] = [];

app.post("/api/naukri/learn/start", async (_req, res) => {
  if (recorder?.isRunning()) {
    res.status(409).json({ error: "Recording already in progress" });
    return;
  }
  learnSteps.length = 0;
  recorder = new NaukriRecorder();
  recorder.setStepCallback((step) => {
    const desc = step.type === "click"    ? `Click "${step.text}"`
               : step.type === "fill"     ? `Fill "${step.label}" = "${step.value.slice(0, 20)}"`
               : step.type === "navigate" ? `Navigate → ${step.url.slice(0, 60)}`
               : step.type === "select"   ? `Select "${step.label}" = "${step.value}"`
               : `Wait ${step.ms}ms`;
    learnSteps.push(desc);
    broadcast("learn_step", { step: desc, total: learnSteps.length });
    logger.info(`[Learn] ${desc}`, { service: "recorder" });
  });

  try {
    await recorder.start("https://www.naukri.com");
    res.json({ ok: true, message: "Browser opened — do your apply flow now, then click Stop" });
  } catch (err) {
    recorder = null;
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/naukri/learn/stop", async (_req, res) => {
  if (!recorder?.isRunning()) {
    res.status(400).json({ error: "No recording in progress" });
    return;
  }
  try {
    const flow = await recorder.stop();
    recorder = null;
    broadcast("learn_done", { steps: flow.steps.length, savedAt: flow.recordedAt });
    res.json({ ok: true, steps: flow.steps.length, savedAt: flow.recordedAt });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/naukri/learn/status", (_req, res) => {
  const flow = loadFlow();
  res.json({
    recording: recorder?.isRunning() ?? false,
    steps:     recorder?.getSteps().length ?? 0,
    liveLog:   learnSteps.slice(-50),
    savedFlow: flow
      ? { recordedAt: flow.recordedAt, stepCount: flow.steps.length, notes: flow.notes }
      : null,
  });
});

app.delete("/api/naukri/learn/flow", (_req, res) => {
  try {
    if (fs.existsSync(FLOW_PATH)) fs.unlinkSync(FLOW_PATH);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/logs", async (req, res) => {
  try {
    await connectDB();
    const limit  = Math.min(Number(req.query["limit"] ?? 200), 500);
    const level  = req.query["level"] as string | undefined;
    const service = req.query["service"] as string | undefined;
    const filter: Record<string, unknown> = {};
    if (level && level !== "all") filter["level"] = level;
    if (service && service !== "all") filter["service"] = service;
    const logs = await SystemLog.find(filter).sort({ timestamp: -1 }).limit(limit).lean();
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: "Could not fetch logs" });
  }
});

app.get("/api/runs", async (_req, res) => {
  const runs = await CrawlRun.find().sort({ createdAt: -1 }).limit(20).select("-logs");
  res.json(runs);
});

app.get("/api/runs/:id/logs", async (req, res) => {
  const run = await CrawlRun.findById(req.params["id"]).select("logs failureReasons jobSnapshot source startedAt status");
  if (!run) { res.status(404).json({ error: "Run not found" }); return; }
  res.json(run);
});

app.get("/api/runs/:id/jobs", async (req, res) => {
  const run = await CrawlRun.findById(req.params["id"]).select("jobSnapshot source startedAt totalFound");
  if (!run) { res.status(404).json({ error: "Run not found" }); return; }
  res.json({ jobs: run.jobSnapshot, source: run.source, startedAt: run.startedAt, totalFound: run.totalFound });
});

// ── analytics aggregation ──────────────────────────────────
app.get("/api/analytics", async (_req, res) => {
  const runs = await CrawlRun.find({ status: "done" })
    .sort({ createdAt: -1 }).limit(50)
    .select("source startedAt totalFound jobsRaw pagesVisited applied skipped failed alreadyApplied durationMs");

  // per-source aggregation
  const bySource: Record<string, { runs: number; totalFound: number; applied: number; skipped: number; failed: number; pagesVisited: number; totalDuration: number }> = {};
  for (const r of runs) {
    const s = r.source;
    if (!bySource[s]) bySource[s] = { runs:0, totalFound:0, applied:0, skipped:0, failed:0, pagesVisited:0, totalDuration:0 };
    bySource[s].runs++;
    bySource[s].totalFound   += r.totalFound   || 0;
    bySource[s].applied      += r.applied      || 0;
    bySource[s].skipped      += r.skipped      || 0;
    bySource[s].failed       += r.failed       || 0;
    bySource[s].pagesVisited += r.pagesVisited || 0;
    bySource[s].totalDuration += r.durationMs  || 0;
  }

  // recent run trend (last 10)
  const trend = runs.slice(0, 10).reverse().map(r => ({
    source: r.source,
    date:   (r.startedAt || "").slice(0, 10),
    found:  r.totalFound || 0,
    applied: r.applied   || 0,
    pages:  r.pagesVisited || 0,
    durationSec: Math.round((r.durationMs || 0) / 1000),
  }));

  res.json({ bySource, trend, totalRuns: runs.length });
});

// ── auth ─────────────────────────────────────────────────
app.get("/api/auth/status", (_req, res) => {
  res.json(getAuthStatus());
});

let loginRunning = false;

app.post("/api/auth/login", (req, res) => {
  const { source } = req.body as { source: string };
  const valid: AuthSource[] = ["naukri", "linkedin", "indeed", "wellfound"];
  if (!valid.includes(source as AuthSource)) {
    res.status(400).json({ error: `Unknown source: ${source}` }); return;
  }
  if (loginRunning) {
    res.status(409).json({ error: "A login is already in progress" }); return;
  }
  res.json({ ok: true });
  loginRunning = true;
  broadcast("auth_status", getAuthStatus());

  loginWithBrowser(source as AuthSource, (msg) => broadcast("log", { msg }))
    .then(() => { broadcast("auth_status", getAuthStatus()); broadcast("log", { msg: `✓ ${source} connected` }); })
    .catch((err) => broadcast("log", { msg: `Login failed: ${err instanceof Error ? err.message : String(err)}` }))
    .finally(() => { loginRunning = false; });
});

// ── profile ───────────────────────────────────────────────
app.get("/api/profile", (_req, res) => {
  res.json(loadProfile());
});

app.post("/api/profile", (req, res) => {
  const updated = saveProfile(req.body);
  res.json({ ok: true, profile: updated });
});

app.post("/api/profile/resume", upload.single("resume"), async (req, res) => {
  if (!req.file) { res.status(400).json({ error: "No file uploaded" }); return; }
  if (!req.file.originalname.endsWith(".pdf") && req.file.mimetype !== "application/pdf") {
    res.status(400).json({ error: "Only PDF files are accepted" }); return;
  }
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync(RESUME_PATH, req.file.buffer);
  saveProfile({ resumePath: RESUME_PATH });

  // Auto-extract profile fields from the PDF
  let extracted = null;
  try {
    extracted = await extractProfileFromPDF(req.file.buffer);
  } catch { /* extraction is best-effort */ }

  res.json({ ok: true, size: req.file.size, extracted });
});

app.get("/api/profile/resume", (_req, res) => {
  if (!fs.existsSync(RESUME_PATH)) { res.status(404).json({ error: "No resume uploaded yet" }); return; }
  res.download(RESUME_PATH, "resume.pdf");
});

app.post("/api/auth/disconnect", (req, res) => {
  const { source } = req.body as { source: string };
  disconnect(source);
  res.json({ ok: true });
  broadcast("auth_status", getAuthStatus());
});

connectDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Dashboard running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("MongoDB connection failed:", err);
    process.exit(1);
  });
