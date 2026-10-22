import { BaseScraper } from "../crawler/base.js";
import type { Job, ApplicationResult, JobsConfig } from "../types/index.js";
import { delay } from "../utils/delay.js";
import { hasApplied } from "../tracker/storage.js";
import { chromium } from "playwright";
import { cookiePath } from "../auth/loginManager.js";
import crypto from "crypto";
import fs from "fs";

const RECOMMENDED_URL = "https://www.naukri.com/mnjuser/recommendedjobs";

export class NaukriScraper extends BaseScraper {
  constructor(cfg: JobsConfig) {
    super(cfg);
  }

  async init(): Promise<void> {
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
    });

    const cp = cookiePath("naukri");
    if (fs.existsSync(cp)) {
      const cookies = JSON.parse(fs.readFileSync(cp, "utf-8"));
      await context.addCookies(cookies);
      this.log("Restored saved Naukri session");
    }

    this.page = await context.newPage();
    this.context = context;
  }

  async login(): Promise<void> {
    await this.page.goto("https://www.naukri.com", { waitUntil: "load", timeout: 30000 });
    await delay(1500, 2000);

    const loggedIn = await this.page.$('.nI-gNb-log-reg-pepole-wrap, [class*="userInfo"], .nI-gNb-Header__search');
    if (loggedIn) {
      this.log("Already logged in via saved session");
      return;
    }

    await this.page.goto("https://www.naukri.com/nlogin/login", { waitUntil: "load" });
    this.log("Browser opened — please log in with Google/OAuth in the browser window");
    this.log("Waiting up to 2 minutes for you to log in…");

    await this.page.waitForURL((url) => !url.href.includes("/nlogin/"), { timeout: 120000 });
    await delay(2000, 3000);

    const cookies = await this.context.cookies();
    fs.mkdirSync("data", { recursive: true });
    fs.writeFileSync(cookiePath("naukri"), JSON.stringify(cookies, null, 2));
    this.log("Session saved — won't need to log in next time");
  }

  async fetchListings(): Promise<Job[]> {
    await this.login();

    this.log("Opening recommended jobs page…");
    await this.page.goto(RECOMMENDED_URL, { waitUntil: "networkidle", timeout: 30000 });
    await delay(2000, 3000);

    const jobs: Job[] = [];
    const { maxResults } = this.cfg.search;
    let scrollAttempts = 0;

    while (jobs.length < maxResults && scrollAttempts < 10) {
      // Naukri recommended jobs uses these selectors
      const cards = await this.page.$$(
        'article.jobTuple, div.jobTuple, [class*="jobTupleHeader"], [data-job-id]'
      );

      if (cards.length === 0) {
        this.log("No job cards found — trying to scroll to load more");
        await this.page.mouse.wheel(0, 800);
        await delay(1500, 2500);
        scrollAttempts++;
        continue;
      }

      for (const card of cards) {
        if (jobs.length >= maxResults) break;
        try {
          const titleEl = await card.$(
            'a.title, a[class*="title"], a[href*="/job-listings-"]'
          );
          const companyEl = await card.$(
            '.companyInfo a, a[class*="comp-name"], [class*="companyName"]'
          );
          const locationEl = await card.$(
            '.location span, span[class*="locWdth"], [class*="location"]'
          );

          const title   = (await titleEl?.innerText())?.trim() ?? "";
          const company = (await companyEl?.innerText())?.trim() ?? "";
          const loc     = (await locationEl?.innerText())?.trim() ?? "";
          const href    = await titleEl?.getAttribute("href");

          if (!title || !href) continue;

          const jobUrl = href.startsWith("http") ? href : `https://www.naukri.com${href}`;
          const id = crypto.createHash("md5").update(jobUrl).digest("hex");

          if (jobs.some((j) => j.id === id)) continue; // deduplicate

          jobs.push({
            id, title, company, location: loc,
            url: jobUrl, source: "naukri",
            easyApply: true,
            foundAt: new Date().toISOString(),
          });
        } catch { /* skip malformed card */ }
      }

      // scroll down to load next batch
      await this.page.mouse.wheel(0, 1200);
      await delay(1500, 2500);
      scrollAttempts++;
    }

    this.log(`Found ${jobs.length} recommended jobs`);
    return jobs;
  }

  async applyToJob(job: Job): Promise<ApplicationResult> {
    if (hasApplied(job.id)) return { job, status: "already_applied" };

    try {
      await this.page.goto(job.url, { waitUntil: "load", timeout: 30000 });
      await delay(1500, 2500);

      // Naukri apply button selectors (multiple fallbacks)
      const applyBtn = await this.page.$(
        '#apply-button, button[id*="apply"], a[id*="apply"], ' +
        'button:has-text("Apply"), div[class*="apply-button"] button'
      );

      if (!applyBtn) {
        this.log(`No apply button found for ${job.title}`);
        return { job, status: "skipped" };
      }

      await applyBtn.click();
      await delay(2000, 3000);

      // Handle the "Apply" confirmation modal if it appears
      const confirmBtn = await this.page.$(
        'button:has-text("Apply"), button[class*="applyBtn"]'
      );
      if (confirmBtn) {
        await confirmBtn.click();
        await delay(1500, 2500);
      }

      // Check for success message
      const success = await this.page.$(
        '[class*="success"], [class*="applied"], div:has-text("application was sent")'
      );

      if (success) {
        this.log(`✓ Applied: ${job.title} @ ${job.company}`);
        return { job, status: "applied", appliedAt: new Date().toISOString() };
      }

      // If no explicit success message, assume applied if no error
      this.log(`Applied (no confirmation shown): ${job.title} @ ${job.company}`);
      return { job, status: "applied", appliedAt: new Date().toISOString() };

    } catch (err) {
      return { job, status: "failed", error: err instanceof Error ? err.message : String(err) };
    }
  }
}
