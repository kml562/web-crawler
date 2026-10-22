import { BaseScraper } from "../crawler/base.js";
import type { Job, ApplicationResult, JobsConfig } from "../types/index.js";
import { delay } from "../utils/delay.js";
import { hasApplied } from "../tracker/storage.js";
import { chromium } from "playwright";
import { cookiePath } from "../auth/loginManager.js";
import crypto from "crypto";
import fs from "fs";

export class NaukriScraper extends BaseScraper {
  constructor(cfg: JobsConfig) {
    super(cfg);
  }

  async init(): Promise<void> {
    // Always open visibly for Naukri — needed for manual OAuth login
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
    });

    // Restore saved cookies if available
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

    // Check if already logged in
    const loggedIn = await this.page.$('.nI-gNb-log-reg-pepole-wrap, [class*="userInfo"], .user-name');
    if (loggedIn) {
      this.log("Already logged in via saved session");
      return;
    }

    // Not logged in — open login page and wait for user to log in manually
    await this.page.goto("https://www.naukri.com/nlogin/login", { waitUntil: "load" });
    this.log("Browser opened — please log in with Google/OAuth in the browser window");
    this.log("Waiting up to 2 minutes for you to log in…");

    // Wait until the URL leaves the login page (user completed login)
    await this.page.waitForURL((url) => !url.href.includes("/nlogin/"), { timeout: 120000 });

    await delay(2000, 3000);

    // Save cookies for next run
    const cookies = await this.context.cookies();
    fs.mkdirSync("data", { recursive: true });
    fs.writeFileSync(cookiePath("naukri"), JSON.stringify(cookies, null, 2));
    this.log("Session saved — won't need to log in next time");
  }

  async fetchListings(): Promise<Job[]> {
    await this.login();

    const { keywords, location, maxResults } = this.cfg.search;
    const slug = (keywords[0] ?? "software-engineer").toLowerCase().replace(/\s+/g, "-");
    const locSlug = (location || "india").toLowerCase().replace(/\s+/g, "-");
    const url = `https://www.naukri.com/${slug}-jobs-in-${locSlug}`;

    await this.page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    await delay(1500, 2500);

    const jobs: Job[] = [];

    while (jobs.length < maxResults) {
      const cards = await this.page.$$('.jobTuple, article.jobTupleHeader');
      if (cards.length === 0) break;

      for (const card of cards) {
        if (jobs.length >= maxResults) break;
        try {
          const titleEl = await card.$('a.title, a[class*="title"]');
          const companyEl = await card.$('.companyInfo a, a[class*="comp-name"]');
          const locationEl = await card.$('.location span, span[class*="locWdth"]');
          const href = await titleEl?.getAttribute("href");
          const title = (await titleEl?.innerText())?.trim() ?? "";
          const company = (await companyEl?.innerText())?.trim() ?? "";
          const loc = (await locationEl?.innerText())?.trim() ?? "";

          if (!title || !href) continue;

          const id = crypto.createHash("md5").update(href).digest("hex");
          const job: Job = { id, title, company, location: loc, url: href, source: "naukri", easyApply: true, foundAt: new Date().toISOString() };
          if (this.matchesSearch(job)) jobs.push(job);
        } catch { /* skip */ }
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
      await this.page.goto(job.url, { waitUntil: "load", timeout: 30000 });
      await delay(1500, 2500);

      const applyBtn = await this.page.$('#apply-button, button:has-text("Apply"), a:has-text("Apply")');
      if (!applyBtn) return { job, status: "skipped" };

      await applyBtn.click();
      await delay(2000, 3000);

      const confirmBtn = await this.page.$('button:has-text("Apply")');
      if (confirmBtn) { await confirmBtn.click(); await delay(1500, 2500); }

      this.log(`Applied to ${job.title} at ${job.company}`);
      return { job, status: "applied", appliedAt: new Date().toISOString() };
    } catch (err) {
      return { job, status: "failed", error: err instanceof Error ? err.message : String(err) };
    }
  }
}
