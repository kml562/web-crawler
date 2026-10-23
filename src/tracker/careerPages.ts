import fs from "fs";
import path from "path";

const FILE = path.resolve("data/career_pages.json");

export interface CareerPageEntry {
  company: string;
  naukriProfileUrl?: string; // naukri.com/company/<slug>
  officialCareerUrl?: string; // company's own careers site
  source: string; // which job board surfaced this company
  foundAt: string;
  lastSeenAt: string;
}

function load(): Record<string, CareerPageEntry> {
  if (!fs.existsSync(FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf-8")) as Record<string, CareerPageEntry>;
  } catch {
    return {};
  }
}

function save(data: Record<string, CareerPageEntry>): void {
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

/** Upsert a career page entry — keyed by lowercase company name */
export function upsertCareerPage(entry: Omit<CareerPageEntry, "foundAt" | "lastSeenAt"> & Partial<Pick<CareerPageEntry, "foundAt">>): void {
  const data = load();
  const key  = entry.company.toLowerCase().trim();
  const now  = new Date().toISOString();

  const existing = data[key];
  data[key] = {
    ...existing,
    ...entry,
    // keep the richer URL if we already have one and new entry doesn't provide one
    naukriProfileUrl:  entry.naukriProfileUrl  ?? existing?.naukriProfileUrl,
    officialCareerUrl: entry.officialCareerUrl ?? existing?.officialCareerUrl,
    foundAt:    existing?.foundAt ?? now,
    lastSeenAt: now,
  };
  save(data);
}

export function getCareerPage(company: string): CareerPageEntry | undefined {
  const data = load();
  return data[company.toLowerCase().trim()];
}

export function listCareerPages(): CareerPageEntry[] {
  return Object.values(load()).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

export function countCareerPages(): number {
  return Object.keys(load()).length;
}
