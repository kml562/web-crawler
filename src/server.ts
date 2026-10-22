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
import { appendResult } from "./tracker/storage.js";
import type { BaseScraper } from "./crawler/base.js";
import { getAuthStatus, loginWithBrowser, disconnect } from "./auth/loginManager.js";
import type { AuthSource } from "./auth/loginManager.js";
import { loadProfile, saveProfile, RESUME_PATH } from "./utils/profile.js";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const PORT = process.env["PORT"] ?? 3000;

app.use(cors());
app.use(express.json());
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
function parseResults(raw: string): ApplicationResult[] {
  try { return JSON.parse(raw) as ApplicationResult[]; }
  catch { throw new Error("Invalid JSON file"); }
}

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
  const { site, autoApply } = req.body as { site: string; autoApply: boolean };

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
    try {
      const cfg = loadJobsConfig();
      if (typeof autoApply === "boolean") cfg.autoApply = autoApply;

      const scraper = scraperForSource(source, cfg);
      if (!scraper) throw new Error(`No scraper for ${source}`);

      broadcast("log", { msg: `Starting ${source} crawler…` });
      await scraper.init();

      broadcast("log", { msg: "Fetching job listings…" });
      const jobs = await scraper.fetchListings();
      broadcast("log", { msg: `Found ${jobs.length} jobs` });
      broadcast("jobs", { count: jobs.length });

      let applied = 0;
      for (const job of jobs) {
        if (applied >= cfg.maxApplicationsPerRun) break;
        if (cfg.autoApply) {
          broadcast("log", { msg: `Applying: ${job.title} @ ${job.company}` });
          const result = await scraper.applyToJob(job);
          appendResult(result);
          if (result.status === "applied") applied++;
          broadcast("progress", { job: job.title, company: job.company, status: result.status });
        } else {
          appendResult({ job, status: "skipped" });
          broadcast("progress", { job: job.title, company: job.company, status: "skipped" });
        }
      }

      await scraper.close();
      await closeBrowser();

      const raw = fs.existsSync("data/applied.json") ? fs.readFileSync("data/applied.json", "utf-8") : "[]";
      const stats = buildStats(parseResults(raw));
      broadcast("done", { applied, total: jobs.length, stats });
      broadcast("log", { msg: `Done! Applied: ${applied} / ${jobs.length}` });

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      broadcast("error", { msg });
      broadcast("log", { msg: `Error: ${msg}` });
    } finally {
      crawlRunning = false;
      broadcast("status", { running: false });
    }
  })();
});

// ── upload JSON ──────────────────────────────────────────
app.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.file) { res.status(400).json({ error: "No file uploaded" }); return; }
  try {
    const raw = req.file.buffer.toString("utf-8");
    const results = parseResults(raw);
    fs.mkdirSync("data", { recursive: true });
    fs.writeFileSync("data/applied.json", raw, "utf-8");
    res.json({ ok: true, count: results.length });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Parse error" });
  }
});

// ── stats ────────────────────────────────────────────────
app.get("/api/stats", (_req, res) => {
  const filePath = "data/applied.json";
  if (!fs.existsSync(filePath)) {
    res.json({ total: 0, byStatus: {}, bySource: {}, byDate: {}, all: [] });
    return;
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  res.json(buildStats(parseResults(raw)));
});

app.get("/api/crawl/status", (_req, res) => {
  res.json({ running: crawlRunning });
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

app.post("/api/profile/resume", upload.single("resume"), (req, res) => {
  if (!req.file) { res.status(400).json({ error: "No file uploaded" }); return; }
  if (!req.file.originalname.endsWith(".pdf") && req.file.mimetype !== "application/pdf") {
    res.status(400).json({ error: "Only PDF files are accepted" }); return;
  }
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync(RESUME_PATH, req.file.buffer);
  saveProfile({ resumePath: RESUME_PATH });
  res.json({ ok: true, size: req.file.size });
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

app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
