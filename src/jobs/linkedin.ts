import { BaseScraper } from "../crawler/base.js";
import type { Job, ApplicationResult, JobsConfig } from "../types/index.js";
import { delay } from "../utils/delay.js";
import { retry } from "../utils/retry.js";
import { hasApplied } from "../tracker/storage.js";
import crypto from "crypto";

export class LinkedInScraper extends BaseScraper {
  constructor(cfg: JobsConfig) {
    super(cfg);
  }

  async login(): Promise<void> {
    const email = process.env["LINKEDIN_EMAIL"] ?? "";
    const password = process.env["LINKEDIN_PASSWORD"] ?? "";

    if (!email || !password) {
      throw new Error("LINKEDIN_EMAIL and LINKEDIN_PASSWORD must be set in .env");
    }

    await this.safeGoto("https://www.linkedin.com/login", "load");
    await this.page.fill("#username", email);
    await delay(300, 700);
    await this.page.fill("#password", password);
    await delay(300, 700);
    await this.page.click('[type="submit"]');
    await this.page.waitForURL("**/feed/**", { timeout: 15000 });
    this.log("Logged in to LinkedIn");
  }

  async fetchListings(): Promise<Job[]> {
    await retry(() => this.login());

    const { keywords, location, remote, maxResults } = this.cfg.search;
    const keyword = keywords.join(" ");
    const remoteParam = remote ? "&f_WT=2" : "";
    const searchUrl = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(keyword)}&location=${encodeURIComponent(location)}${remoteParam}&f_LF=f_AL`;

    await this.safeGoto(searchUrl);

    const jobs: Job[] = [];
    let page = 0;

    while (jobs.length < maxResults) {
      const cards = await this.page.$$(".job-card-container");
      if (cards.length === 0) break;

      for (const card of cards) {
        if (jobs.length >= maxResults) break;
        try {
          const titleEl = await card.$(".job-card-list__title");
          const companyEl = await card.$(".job-card-container__company-name");
          const locationEl = await card.$(".job-card-container__metadata-item");
          const linkEl = await card.$("a.job-card-list__title");
          const easyApplyEl = await card.$(".job-card-container__apply-method");

          const title = (await titleEl?.innerText())?.trim() ?? "";
          const company = (await companyEl?.innerText())?.trim() ?? "";
          const loc = (await locationEl?.innerText())?.trim() ?? "";
          const href = await linkEl?.getAttribute("href");
          const easyApply = (await easyApplyEl?.innerText())?.includes("Easy Apply") ?? false;

          if (!title || !href) continue;

          const url = href.startsWith("http") ? href : `https://www.linkedin.com${href}`;
          const id = crypto.createHash("md5").update(url).digest("hex");

          const job: Job = {
            id,
            title,
            company,
            location: loc,
            url,
            source: "linkedin",
            easyApply,
            foundAt: new Date().toISOString(),
          };

          if (this.matchesSearch(job)) jobs.push(job);
        } catch {
          // skip malformed card
        }
      }

      // scroll to load more or go to next page
      const nextBtn = await this.page.$('button[aria-label="View next page"]');
      if (!nextBtn) break;
      await nextBtn.click();
      await delay(2000, 3500);
      page++;
    }

    this.log(`Found ${jobs.length} jobs`);
    return jobs;
  }

  async applyToJob(job: Job): Promise<ApplicationResult> {
    if (await hasApplied(job.id)) {
      return { job, status: "already_applied" };
    }
    if (!job.easyApply) {
      return { job, status: "skipped" };
    }

    try {
      await this.safeGoto(job.url, "load");
      await delay(1000, 2000);

      const easyApplyBtn = await this.page.$('.jobs-apply-button--top-card button');
      if (!easyApplyBtn) return { job, status: "skipped" };

      await easyApplyBtn.click();
      await delay(1500, 2500);

      // Walk through multi-step Easy Apply modal
      let step = 0;
      while (step < 10) {
        const nextBtn = await this.page.$('button[aria-label="Continue to next step"]');
        const submitBtn = await this.page.$('button[aria-label="Submit application"]');
        const reviewBtn = await this.page.$('button[aria-label="Review your application"]');

        if (submitBtn) {
          await submitBtn.click();
          await delay(1500, 2000);
          this.log(`Applied to ${job.title} at ${job.company}`);
          return { job, status: "applied", appliedAt: new Date().toISOString() };
        }
        if (reviewBtn) {
          await reviewBtn.click();
        } else if (nextBtn) {
          await nextBtn.click();
        } else {
          break;
        }
        await delay(1000, 2000);
        step++;
      }

      return { job, status: "failed", error: "Could not complete Easy Apply flow" };
    } catch (err) {
      return { job, status: "failed", error: err instanceof Error ? err.message : String(err) };
    }
  }
}
