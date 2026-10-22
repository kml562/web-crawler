import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";
import type { ApplicationResult } from "./types/index.js";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const PORT = process.env["PORT"] ?? 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.resolve("public")));

function parseResults(raw: string): ApplicationResult[] {
  try {
    return JSON.parse(raw) as ApplicationResult[];
  } catch {
    throw new Error("Invalid JSON file");
  }
}

function buildStats(results: ApplicationResult[]) {
  const byStatus = { applied: 0, skipped: 0, failed: 0, already_applied: 0 };
  const bySource: Record<string, number> = {};
  const byDate: Record<string, number> = {};

  for (const r of results) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;

    const src = r.job.source;
    bySource[src] = (bySource[src] ?? 0) + 1;

    const date = (r.appliedAt ?? r.job.foundAt ?? "").slice(0, 10);
    if (date) byDate[date] = (byDate[date] ?? 0) + 1;
  }

  return {
    total: results.length,
    byStatus,
    bySource,
    byDate,
    recent: results
      .filter((r) => r.status === "applied")
      .sort((a, b) => (b.appliedAt ?? "").localeCompare(a.appliedAt ?? ""))
      .slice(0, 20)
      .map((r) => ({
        title: r.job.title,
        company: r.job.company,
        source: r.job.source,
        location: r.job.location,
        url: r.job.url,
        appliedAt: r.appliedAt,
        status: r.status,
      })),
    all: results.map((r) => ({
      title: r.job.title,
      company: r.job.company,
      source: r.job.source,
      location: r.job.location,
      url: r.job.url,
      appliedAt: r.appliedAt ?? r.job.foundAt,
      status: r.status,
      error: r.error,
    })),
  };
}

// Upload JSON file
app.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded" });
    return;
  }
  try {
    const raw = req.file.buffer.toString("utf-8");
    const results = parseResults(raw);

    // save locally for /api/stats to reuse
    fs.mkdirSync("data", { recursive: true });
    fs.writeFileSync("data/applied.json", raw, "utf-8");

    res.json({ ok: true, count: results.length });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Parse error" });
  }
});

// Get stats from saved file
app.get("/api/stats", (_req, res) => {
  const filePath = "data/applied.json";
  if (!fs.existsSync(filePath)) {
    res.json({ total: 0, byStatus: {}, bySource: {}, byDate: {}, recent: [], all: [] });
    return;
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  const results = parseResults(raw);
  res.json(buildStats(results));
});

app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
