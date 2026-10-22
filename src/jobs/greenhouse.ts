import { BaseScraper } from "../crawler/base.js";
import type { Job, ApplicationResult, JobsConfig } from "../types/index.js";
import { delay } from "../utils/delay.js";
import { hasApplied } from "../tracker/storage.js";
import axios from "axios";
import crypto from "crypto";

// Greenhouse boards follow the pattern: boards.greenhouse.io/{company}/jobs
// We query their public JSON API — no login needed
const KNOWN_COMPANIES = [
  "stripe", "airbnb", "figma", "notion", "vercel", "shopify",
  "discord", "linear", "clerk", "supabase", "planetscale",
];

export class GreenhouseScraper extends BaseScraper {
  constructor(cfg: JobsConfig) {
    super(cfg);
  }

  async fetchListings(): Promise<Job[]> {
    const { keywords, maxResults } = this.cfg.search;
    const jobs: Job[] = [];

    for (const company of KNOWN_COMPANIES) {
      if (jobs.length >= maxResults) break;
      try {
        const res = await axios.get<{ jobs: Array<{ id: number; title: string; location: { name: string }; absolute_url: string }> }>(
          `https://boards-api.greenhouse.io/v1/boards/${company}/jobs`,
          { timeout: 10000 }
        );

        for (const item of res.data.jobs) {
          if (jobs.length >= maxResults) break;
          const titleLower = item.title.toLowerCase();
          if (!keywords.some((kw) => titleLower.includes(kw.toLowerCase()))) continue;

          const id = crypto.createHash("md5").update(item.absolute_url).digest("hex");
          const job: Job = {
            id,
            title: item.title,
            company,
            location: item.location.name,
            url: item.absolute_url,
            source: "greenhouse",
            easyApply: true,
            foundAt: new Date().toISOString(),
          };

          if (this.matchesSearch(job)) jobs.push(job);
        }
      } catch {
        // company may not use Greenhouse or API is down — skip
      }
    }

    this.log(`Found ${jobs.length} jobs`);
    return jobs;
  }

  async applyToJob(job: Job): Promise<ApplicationResult> {
    if (hasApplied(job.id)) return { job, status: "already_applied" };

    try {
      await this.safeGoto(job.url, "load");
      await delay(1500, 2500);

      const applyBtn = await this.page.$('#apply_button, a:has-text("Apply for this Job")');
      if (!applyBtn) return { job, status: "skipped" };

      await applyBtn.click();
      await delay(1500, 2500);

      // Fill first name, last name, email
      const { firstName, lastName, email, phone, resumePath: _ } = {
        firstName: this.cfg.resume.firstName,
        lastName: this.cfg.resume.lastName,
        email: this.cfg.resume.email,
        phone: this.cfg.resume.phone,
        resumePath: this.cfg.resume.path,
      };

      await this.fillIfPresent('input[id*="first_name"]', firstName);
      await this.fillIfPresent('input[id*="last_name"]', lastName);
      await this.fillIfPresent('input[id*="email"]', email);
      await this.fillIfPresent('input[id*="phone"]', phone);

      if (this.cfg.resume.path) {
        const uploadEl = await this.page.$('input[type="file"]');
        if (uploadEl) await uploadEl.setInputFiles(this.cfg.resume.path);
      }

      await delay(800, 1500);
      const submitBtn = await this.page.$('input[type="submit"], button[type="submit"]');
      if (submitBtn) {
        await submitBtn.click();
        await delay(2000, 3000);
        this.log(`Applied to ${job.title} at ${job.company}`);
        return { job, status: "applied", appliedAt: new Date().toISOString() };
      }

      return { job, status: "failed", error: "Could not find submit button" };
    } catch (err) {
      return { job, status: "failed", error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async fillIfPresent(selector: string, value: string): Promise<void> {
    const el = await this.page.$(selector);
    if (el && value) {
      await el.fill(value);
      await delay(200, 500);
    }
  }
}
