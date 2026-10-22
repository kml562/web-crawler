import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import type { ApplicationResult } from "../types/index.js";

const DB_PATH = path.resolve("data/jobs.db");

function getDb(): Database.Database {
  fs.mkdirSync("data", { recursive: true });
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS applications (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      company     TEXT NOT NULL,
      location    TEXT,
      url         TEXT,
      source      TEXT,
      easy_apply  INTEGER,
      found_at    TEXT,
      status      TEXT NOT NULL,
      applied_at  TEXT,
      error       TEXT,
      raw         TEXT NOT NULL
    )
  `);
  return db;
}

export function appendResult(result: ApplicationResult): void {
  const db = getDb();
  const { job, status, appliedAt, error } = result;
  db.prepare(`
    INSERT OR REPLACE INTO applications
      (id, title, company, location, url, source, easy_apply, found_at, status, applied_at, error, raw)
    VALUES
      (@id, @title, @company, @location, @url, @source, @easyApply, @foundAt, @status, @appliedAt, @error, @raw)
  `).run({
    id: job.id,
    title: job.title,
    company: job.company,
    location: job.location ?? null,
    url: job.url,
    source: job.source,
    easyApply: job.easyApply ? 1 : 0,
    foundAt: job.foundAt ?? null,
    status,
    appliedAt: appliedAt ?? null,
    error: error ?? null,
    raw: JSON.stringify(result),
  });
  db.close();
}

export function hasApplied(jobId: string): boolean {
  const db = getDb();
  const row = db.prepare(`SELECT 1 FROM applications WHERE id = ? AND status = 'applied'`).get(jobId);
  db.close();
  return !!row;
}

export function loadApplied(): ApplicationResult[] {
  const db = getDb();
  const rows = db.prepare(`SELECT raw FROM applications ORDER BY rowid DESC`).all() as { raw: string }[];
  db.close();
  return rows.map((r) => JSON.parse(r.raw) as ApplicationResult);
}

export function getSummary() {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(status='applied') as applied,
      SUM(status='failed') as failed,
      SUM(status='skipped') as skipped
    FROM applications
  `).get() as { total: number; applied: number; failed: number; skipped: number };
  db.close();
  return row;
}
