import { BaseScraper } from "../crawler/base.js";
import type { Job, ApplicationResult, JobsConfig } from "../types/index.js";
import { delay } from "../utils/delay.js";
import { hasApplied } from "../tracker/storage.js";
import crypto from "crypto";

export class IndeedScraper extends BaseScraper {
  constructor(cfg: JobsConfig) {
    super(cfg);
  }

  async fetchListings(): Promise<Job[]> {
    const { keywords, location, remote, maxResults } = this.cfg.search;
    const keyword = keywords.join(" ");
    const remoteParam = remote ? "&remotejob=032b3046-06a3-4876-8dfd-474eb5e7ed11" : "";
    const url = `https://www.indeed.com/jobs?q=${encodeURIComponent(keyword)}&l=${encodeURIComponent(location)}${remoteParam}`;

    await this.safeGoto(url);

    const jobs: Job[] = [];

    while (jobs.length < maxResults) {
      const cards = await this.page.$$('[data-testid="slider_item"]');
      if (cards.length === 0) break;

      for (const card of cards) {
        if (jobs.length >= maxResults) break;
        try {
          const titleEl = await card.$('[data-testid="jobTitle"] span');
          const companyEl = await card.$('[data-testid="company-name"]');
          const locationEl = await card.$('[data-testid="text-location"]');
          const linkEl = await card.$('a[data-testid="job-title-link"]');

          const title = (await titleEl?.innerText())?.trim() ?? "";
          const company = (await companyEl?.innerText())?.trim() ?? "";
          const loc = (await locationEl?.innerText())?.trim() ?? "";
          const href = await linkEl?.getAttribute("href");

          if (!title || !href) continue;

          const url = href.startsWith("http") ? href : `https://www.indeed.com${href}`;
          const id = crypto.createHash("md5").update(url).digest("hex");

          const job: Job = {
            id,
            title,
            company,
            location: loc,
            url,
            source: "indeed",
            easyApply: true,
            foundAt: new Date().toISOString(),
          };

          if (this.matchesSearch(job)) jobs.push(job);
        } catch {
          // skip malformed card
        }
      }

      const nextBtn = await this.page.$('a[data-testid="pagination-page-next"]');
      if (!nextBtn) break;
      await nextBtn.click();
      await delay(2000, 3500);
    }

    this.log(`Found ${jobs.length} jobs`);
    return jobs;
  }

  async applyToJob(job: Job): Promise<ApplicationResult> {
    if (await hasApplied(job.id)) return { job, status: "already_applied" };

    try {
      await this.safeGoto(job.url, "load");
      await delay(1500, 2500);

      const applyBtn = await this.page.$('button[id="indeedApplyButton"]');
      if (!applyBtn) return { job, status: "skipped" };

      // Indeed opens a new tab for application
      const [newPage] = await Promise.all([
        this.context.waitForEvent("page"),
        applyBtn.click(),
      ]);

      await newPage.waitForLoadState("networkidle");
      await delay(2000, 3000);

      // Indeed apply flow varies — mark as skipped for manual review
      await newPage.close();
      this.log(`Opened Indeed apply for ${job.title} — manual review needed`);
      return { job, status: "skipped" };
    } catch (err) {
      return { job, status: "failed", error: err instanceof Error ? err.message : String(err) };
    }
  }
}
