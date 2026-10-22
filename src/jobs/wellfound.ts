import { BaseScraper } from "../crawler/base.js";
import type { Job, ApplicationResult, JobsConfig } from "../types/index.js";
import { delay } from "../utils/delay.js";
import { hasApplied } from "../tracker/storage.js";
import crypto from "crypto";

export class WellfoundScraper extends BaseScraper {
  constructor(cfg: JobsConfig) {
    super(cfg);
  }

  async fetchListings(): Promise<Job[]> {
    const { keywords, remote, maxResults } = this.cfg.search;
    const keyword = keywords.join("-").toLowerCase();
    const remoteParam = remote ? "?remote=true" : "";
    const url = `https://wellfound.com/role/r/${encodeURIComponent(keyword)}${remoteParam}`;

    await this.safeGoto(url);

    const jobs: Job[] = [];

    while (jobs.length < maxResults) {
      const cards = await this.page.$$('[data-test="StartupResult"]');
      if (cards.length === 0) break;

      for (const card of cards) {
        if (jobs.length >= maxResults) break;
        try {
          const jobLinks = await card.$$('a[href*="/jobs/"]');
          for (const linkEl of jobLinks) {
            if (jobs.length >= maxResults) break;
            const title = (await linkEl.innerText())?.trim() ?? "";
            const href = await linkEl.getAttribute("href");
            const companyEl = await card.$('[data-test="startup-name"]');
            const company = (await companyEl?.innerText())?.trim() ?? "";

            if (!title || !href) continue;

            const jobUrl = href.startsWith("http") ? href : `https://wellfound.com${href}`;
            const id = crypto.createHash("md5").update(jobUrl).digest("hex");

            const job: Job = {
              id,
              title,
              company,
              location: remote ? "Remote" : "",
              url: jobUrl,
              source: "wellfound",
              easyApply: true,
              foundAt: new Date().toISOString(),
            };

            if (this.matchesSearch(job)) jobs.push(job);
          }
        } catch {
          // skip
        }
      }

      const loadMoreBtn = await this.page.$('button:has-text("Load more")');
      if (!loadMoreBtn) break;
      await loadMoreBtn.click();
      await delay(2000, 3000);
    }

    this.log(`Found ${jobs.length} jobs`);
    return jobs;
  }

  async applyToJob(job: Job): Promise<ApplicationResult> {
    if (hasApplied(job.id)) return { job, status: "already_applied" };

    try {
      await this.safeGoto(job.url, "load");
      await delay(1500, 2500);

      const applyBtn = await this.page.$('button:has-text("Apply")');
      if (!applyBtn) return { job, status: "skipped" };

      await applyBtn.click();
      await delay(2000, 3000);

      // Wellfound apply requires account + profile — mark skipped for manual
      this.log(`Opened Wellfound apply for ${job.title} — manual review needed`);
      return { job, status: "skipped" };
    } catch (err) {
      return { job, status: "failed", error: err instanceof Error ? err.message : String(err) };
    }
  }
}
