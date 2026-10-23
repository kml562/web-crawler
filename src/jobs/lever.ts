import { BaseScraper } from "../crawler/base.js";
import type { Job, ApplicationResult, JobsConfig } from "../types/index.js";
import { delay } from "../utils/delay.js";
import { hasApplied } from "../tracker/storage.js";
import { loadProfile } from "../utils/profile.js";
import axios from "axios";
import crypto from "crypto";

// Lever boards follow: jobs.lever.co/{company}
const KNOWN_COMPANIES = [
  "netflix", "coinbase", "robinhood", "plaid", "brex",
  "rippling", "lattice", "airtable", "retool", "scale",
];

export class LeverScraper extends BaseScraper {
  constructor(cfg: JobsConfig) {
    super(cfg);
  }

  async fetchListings(): Promise<Job[]> {
    const { keywords, maxResults } = this.cfg.search;
    const jobs: Job[] = [];

    for (const company of KNOWN_COMPANIES) {
      if (jobs.length >= maxResults) break;
      try {
        const res = await axios.get<Array<{ id: string; text: string; categories: { location: string }; hostedUrl: string }>>(
          `https://api.lever.co/v0/postings/${company}?mode=json`,
          { timeout: 10000 }
        );

        for (const item of res.data) {
          if (jobs.length >= maxResults) break;
          const titleLower = item.text.toLowerCase();
          if (!keywords.some((kw) => titleLower.includes(kw.toLowerCase()))) continue;

          const id = crypto.createHash("md5").update(item.hostedUrl).digest("hex");
          const job: Job = {
            id,
            title: item.text,
            company,
            location: item.categories.location ?? "",
            url: item.hostedUrl,
            source: "lever",
            easyApply: true,
            foundAt: new Date().toISOString(),
          };

          if (this.matchesSearch(job)) jobs.push(job);
        }
      } catch {
        // company may not use Lever or API is down — skip
      }
    }

    this.log(`Found ${jobs.length} jobs`);
    return jobs;
  }

  async applyToJob(job: Job): Promise<ApplicationResult> {
    if (await hasApplied(job.id)) return { job, status: "already_applied" };

    try {
      await this.safeGoto(job.url, "load");
      await delay(1500, 2500);

      const applyBtn = await this.page.$('a:has-text("Apply for this job"), .postings-btn:has-text("Apply")');
      if (!applyBtn) return { job, status: "skipped" };

      await applyBtn.click();
      await delay(1500, 2500);

      const profile = loadProfile();
      await this.fillIfPresent('input[name="name"]', `${profile.firstName} ${profile.lastName}`);
      await this.fillIfPresent('input[name="email"]', profile.email);
      await this.fillIfPresent('input[name="phone"]', profile.phone);
      if (profile.linkedinUrl) await this.fillIfPresent('input[name="urls[LinkedIn]"]', profile.linkedinUrl);
      if (profile.portfolioUrl) await this.fillIfPresent('input[name="urls[Portfolio]"]', profile.portfolioUrl);
      if (profile.resumePath) {
        const uploadEl = await this.page.$('input[type="file"]');
        if (uploadEl) await uploadEl.setInputFiles(profile.resumePath);
      }

      await this.fillScreeningQuestions();
      await delay(800, 1500);
      const submitBtn = await this.page.$('button[type="submit"]');
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
