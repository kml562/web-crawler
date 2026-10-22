import { BaseScraper } from "../crawler/base.js";
import type { Job, ApplicationResult, JobsConfig } from "../types/index.js";
import { delay } from "../utils/delay.js";
import { hasApplied } from "../tracker/storage.js";
import crypto from "crypto";

export class WeWorkRemotelyScraper extends BaseScraper {
  constructor(cfg: JobsConfig) {
    super(cfg);
  }

  async fetchListings(): Promise<Job[]> {
    const { keywords, maxResults } = this.cfg.search;
    const keyword = keywords.join("+");
    const url = `https://weworkremotely.com/remote-jobs/search?term=${encodeURIComponent(keyword)}`;

    await this.safeGoto(url);

    const jobs: Job[] = [];
    const cards = await this.page.$$("ul.jobs li.feature");

    for (const card of cards) {
      if (jobs.length >= maxResults) break;
      try {
        const titleEl = await card.$("span.title");
        const companyEl = await card.$("span.company");
        const linkEl = await card.$("a");

        const title = (await titleEl?.innerText())?.trim() ?? "";
        const company = (await companyEl?.innerText())?.trim() ?? "";
        const href = await linkEl?.getAttribute("href");

        if (!title || !href) continue;

        const jobUrl = href.startsWith("http") ? href : `https://weworkremotely.com${href}`;
        const id = crypto.createHash("md5").update(jobUrl).digest("hex");

        const job: Job = {
          id,
          title,
          company,
          location: "Remote",
          url: jobUrl,
          source: "weworkremotely",
          easyApply: false,
          foundAt: new Date().toISOString(),
        };

        if (this.matchesSearch(job)) jobs.push(job);
      } catch {
        // skip
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

      // WWR links out to company apply page — save for manual apply
      const applyBtn = await this.page.$('a.button:has-text("Apply")');
      if (!applyBtn) return { job, status: "skipped" };

      const externalUrl = await applyBtn.getAttribute("href");
      this.log(`Apply externally at: ${externalUrl ?? job.url}`);
      return { job, status: "skipped" };
    } catch (err) {
      return { job, status: "failed", error: err instanceof Error ? err.message : String(err) };
    }
  }
}
