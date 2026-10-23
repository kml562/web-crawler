import mongoose, { Schema, type Document } from "mongoose";

export interface CrawlRunDoc extends Document {
  source: string;
  startedAt: string;
  finishedAt: string;
  autoApply: boolean;
  // extraction tracking
  pagesVisited: number;
  jobsRaw: number;       // returned by scraper before filter
  jobsFiltered: number;  // after keyword/exclude filter
  totalFound: number;    // alias for jobsFiltered (kept for compat)
  // application counts
  applied: number;
  skipped: number;
  failed: number;
  alreadyApplied: number;
  // per-job snapshot (title, company, status)
  jobSnapshot: Array<{ title: string; company: string; location: string; url: string; status: string; error?: string }>;
  logs: Array<{ time: string; level: "info" | "warn" | "error"; msg: string }>;
  failureReasons: Array<{ jobTitle: string; company: string; reason: string; url: string }>;
  status: "running" | "done" | "error";
  errorMessage?: string;
  durationMs: number;
}

const CrawlRunSchema = new Schema<CrawlRunDoc>({
  source:         { type: String, required: true },
  startedAt:      { type: String, required: true },
  finishedAt:     { type: String, default: "" },
  autoApply:      { type: Boolean, default: false },
  pagesVisited:   { type: Number, default: 0 },
  jobsRaw:        { type: Number, default: 0 },
  jobsFiltered:   { type: Number, default: 0 },
  totalFound:     { type: Number, default: 0 },
  applied:        { type: Number, default: 0 },
  skipped:        { type: Number, default: 0 },
  failed:         { type: Number, default: 0 },
  alreadyApplied: { type: Number, default: 0 },
  durationMs:     { type: Number, default: 0 },
  jobSnapshot:    [{ title: String, company: String, location: String, url: String, status: String, error: String }],
  logs: [{
    time:  String,
    level: { type: String, enum: ["info", "warn", "error"] },
    msg:   String,
  }],
  failureReasons: [{
    jobTitle: String,
    company:  String,
    reason:   String,
    url:      String,
  }],
  status:       { type: String, enum: ["running", "done", "error"], default: "running" },
  errorMessage: { type: String, default: "" },
}, { timestamps: true });

export const CrawlRun = mongoose.models["CrawlRun"] as mongoose.Model<CrawlRunDoc>
  ?? mongoose.model<CrawlRunDoc>("CrawlRun", CrawlRunSchema);
