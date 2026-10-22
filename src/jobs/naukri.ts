import { BaseScraper } from "../crawler/base.js";
import type { Job, ApplicationResult, JobsConfig } from "../types/index.js";
import { delay } from "../utils/delay.js";
import { hasApplied } from "../tracker/storage.js";
import crypto from "crypto";

export class NaukriScraper extends BaseScraper {
  constructor(cfg: JobsConfig) {
    super(cfg);
  }

  async login(): Promise<void> {
    const email = process.env["NAUKRI_EMAIL"] ?? "";
    const password = process.env["NAUKRI_PASSWORD"] ?? "";
    if (!email || !password) {
      throw new Error("NAUKRI_EMAIL and NAUKRI_PASSWORD must be set in .env");
    }

    await this.safeGoto("https://www.naukri.com/nlogin/login", "load");
    await delay(1000, 2000);

    await this.page.fill('#usernameField', email);
    await delay(300, 700);
    await this.page.fill('#passwordField', password);
    await delay(300, 700);
    await this.page.click('button[type="submit"]');
    await this.page.waitForURL("**/mnjuser/homepage**", { timeout: 15000 });
    this.log("Logged in to Naukri");
  }

  async fetchListings(): Promise<Job[]> {
    await this.login();

    const { keywords, location, maxResults } = this.cfg.search;
    const keyword = keywords.join("%20");
    const url = `https://www.naukri.com/${encodeURIComponent(keywords[0] ?? "software-engineer")}-jobs-in-${encodeURIComponent(location.toLowerCase().replace(/\s+/g, "-"))}`;

    await this.safeGoto(url);
    const jobs: Job[] = [];

    while (jobs.length < maxResults) {
      const cards = await this.page.$$('.jobTuple');
      if (cards.length === 0) break;

      for (const card of cards) {
        if (jobs.length >= maxResults) break;
        try {
          const titleEl = await card.$('a.title');
          const companyEl = await card.$('.companyInfo a');
          const locationEl = await card.$('.location span');
          const href = await titleEl?.getAttribute("href");
          const title = (await titleEl?.innerText())?.trim() ?? "";
          const company = (await companyEl?.innerText())?.trim() ?? "";
          const loc = (await locationEl?.innerText())?.trim() ?? "";

          if (!title || !href) continue;

          const id = crypto.createHash("md5").update(href).digest("hex");
          const job: Job = {
            id,
            title,
            company,
            location: loc,
            url: href,
            source: "naukri",
            easyApply: true,
            foundAt: new Date().toISOString(),
          };

          if (this.matchesSearch(job)) jobs.push(job);
        } catch {
          // skip
        }
      }

      const nextBtn = await this.page.$('a[title="Next"]');
      if (!nextBtn) break;
      await nextBtn.click();
      await delay(2000, 3500);
    }

    this.log(`Found ${jobs.length} jobs`);
    return jobs;
  }

  async applyToJob(job: Job): Promise<ApplicationResult> {
    if (hasApplied(job.id)) return { job, status: "already_applied" };

    try {
      await this.safeGoto(job.url, "load");
      await delay(1500, 2500);

      const applyBtn = await this.page.$('#apply-button, button:has-text("Apply")');
      if (!applyBtn) return { job, status: "skipped" };

      await applyBtn.click();
      await delay(2000, 3000);

      // Check for confirmation dialog
      const confirmBtn = await this.page.$('button:has-text("Apply")');
      if (confirmBtn) {
        await confirmBtn.click();
        await delay(1500, 2500);
      }

      this.log(`Applied to ${job.title} at ${job.company}`);
      return { job, status: "applied", appliedAt: new Date().toISOString() };
    } catch (err) {
      return { job, status: "failed", error: err instanceof Error ? err.message : String(err) };
    }
  }
}
