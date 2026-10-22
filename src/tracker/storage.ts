import fs from "fs";
import path from "path";
import type { ApplicationResult } from "../types/index.js";

const DATA_FILE = path.resolve("data/applied.json");

function ensureFile(): void {
  if (!fs.existsSync("data")) fs.mkdirSync("data", { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "[]", "utf-8");
}

export function loadApplied(): ApplicationResult[] {
  ensureFile();
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8")) as ApplicationResult[];
}

export function saveApplied(results: ApplicationResult[]): void {
  ensureFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(results, null, 2), "utf-8");
}

export function appendResult(result: ApplicationResult): void {
  const existing = loadApplied();
  existing.push(result);
  saveApplied(existing);
}

export function hasApplied(jobId: string): boolean {
  const existing = loadApplied();
  return existing.some((r) => r.job.id === jobId && r.status === "applied");
}

export function getSummary(): { total: number; applied: number; failed: number; skipped: number } {
  const results = loadApplied();
  return {
    total: results.length,
    applied: results.filter((r) => r.status === "applied").length,
    failed: results.filter((r) => r.status === "failed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
  };
}
