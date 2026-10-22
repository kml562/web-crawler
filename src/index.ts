import { loadJobsConfig } from "./config/index.js";
import { closeBrowser } from "./crawler/browser.js";
import { LinkedInScraper } from "./jobs/linkedin.js";
import { IndeedScraper } from "./jobs/indeed.js";
import { WellfoundScraper } from "./jobs/wellfound.js";
import { WeWorkRemotelyScraper } from "./jobs/weworkremotely.js";
import { GreenhouseScraper } from "./jobs/greenhouse.js";
import { LeverScraper } from "./jobs/lever.js";
import { NaukriScraper } from "./jobs/naukri.js";
import { appendResult, getSummary } from "./tracker/storage.js";
import { logger } from "./utils/logger.js";
import type { BaseScraper } from "./crawler/base.js";
import type { Job } from "./types/index.js";

async function main() {
  const cfg = loadJobsConfig();
  logger.info(`Starting job crawler | autoApply=${cfg.autoApply} | maxPerRun=${cfg.maxApplicationsPerRun}`);

  const scrapers: BaseScraper[] = [];
  if (cfg.sources.linkedin)       scrapers.push(new LinkedInScraper(cfg));
  if (cfg.sources.indeed)         scrapers.push(new IndeedScraper(cfg));
  if (cfg.sources.wellfound)      scrapers.push(new WellfoundScraper(cfg));
  if (cfg.sources.weworkremotely) scrapers.push(new WeWorkRemotelyScraper(cfg));
  if (cfg.sources.greenhouse)     scrapers.push(new GreenhouseScraper(cfg));
  if (cfg.sources.lever)          scrapers.push(new LeverScraper(cfg));
  if (cfg.sources.naukri)         scrapers.push(new NaukriScraper(cfg));

  const allJobs: Job[] = [];
  let applied = 0;

  for (const scraper of scrapers) {
    try {
      await scraper.init();
      const jobs = await scraper.fetchListings();
      allJobs.push(...jobs);

      if (cfg.autoApply) {
        for (const job of jobs) {
          if (applied >= cfg.maxApplicationsPerRun) break;
          const result = await scraper.applyToJob(job);
          await appendResult(result);
          if (result.status === "applied") {
            applied++;
            logger.success(`Applied [${applied}/${cfg.maxApplicationsPerRun}]: ${job.title} @ ${job.company}`);
          } else {
            logger.info(`${result.status}: ${job.title} @ ${job.company}`);
          }
        }
      }
    } catch (err) {
      logger.error(`Scraper ${scraper.constructor.name} failed`, err);
    } finally {
      await scraper.close();
    }
  }

  await closeBrowser();

  if (!cfg.autoApply) {
    logger.info(`\nFound ${allJobs.length} total jobs (autoApply is off — set in jobs.config.json to apply)`);
    logger.info("Jobs saved to data/applied.json for review");
    for (const job of allJobs) {
      await appendResult({ job, status: "skipped" });
    }
  }

  const summary = await getSummary();
  logger.success(`\nDone! Applied: ${summary.applied} | Skipped: ${summary.skipped} | Failed: ${summary.failed}`);
}

main().catch((err) => {
  logger.error("Fatal error", err);
  process.exit(1);
});
