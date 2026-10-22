import { BaseScraper } from "../crawler/base.js";
import type { Job, ApplicationResult, JobsConfig } from "../types/index.js";
import { delay } from "../utils/delay.js";
import { hasApplied } from "../tracker/storage.js";
import { chromium } from "playwright";
import { cookiePath } from "../auth/loginManager.js";
import axios from "axios";
import crypto from "crypto";
import fs from "fs";

const RECOM_API = "https://www.naukri.com/jobapi/v2/search/recom-jobs";
const BASE_URL  = "https://www.naukri.com";

interface NaukriJob {
  jobId: string;
  title: string;
  companyName: string;
  jdURL: string;
  tagsAndSkills?: string;
  placeholders?: Array<{ type: string; label: string }>;
}

interface RecomResponse {
  noOfJobs: number;
  jobDetails: NaukriJob[];
}

export class NaukriScraper extends BaseScraper {
  private cookieHeader = "";

  constructor(cfg: JobsConfig) {
    super(cfg);
  }

  // Build a cookie string from saved Playwright cookies
  private loadCookies(): string {
    const cp = cookiePath("naukri");
    if (!fs.existsSync(cp)) return "";
    const cookies: Array<{ name: string; value: string }> = JSON.parse(fs.readFileSync(cp, "utf-8"));
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  }

  async init(): Promise<void> {
    this.cookieHeader = this.loadCookies();

    if (!this.cookieHeader) {
      // No saved session — open browser for manual login
      const browser = await chromium.launch({ headless: false });
      const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        viewport: { width: 1280, height: 800 },
      });
      this.page = await context.newPage();
      this.context = context;

      await this.login();
      this.cookieHeader = this.loadCookies();
    } else {
      // Has session — still need a browser page for apply flow
      const browser = await chromium.launch({ headless: false });
      const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        viewport: { width: 1280, height: 800 },
      });
      const cookies: Array<{ name: string; value: string; domain: string; path: string }> =
        JSON.parse(fs.readFileSync(cookiePath("naukri"), "utf-8"));
      await context.addCookies(cookies);
      this.page = await context.newPage();
      this.context = context;
      this.log("Using saved Naukri session");
    }
  }

  async login(): Promise<void> {
    await this.page.goto(`${BASE_URL}/nlogin/login`, { waitUntil: "load" });
    this.log("Browser opened — log in with Google/OAuth, waiting up to 2 minutes…");

    await this.page.waitForURL((url) => !url.href.includes("/nlogin/"), { timeout: 120000 });
    await delay(2000, 3000);

    const cookies = await this.context.cookies();
    fs.mkdirSync("data", { recursive: true });
    fs.writeFileSync(cookiePath("naukri"), JSON.stringify(cookies, null, 2));
    this.log("Session saved");
  }

  private apiHeaders() {
    return {
      "accept":           "application/json",
      "content-type":     "application/json",
      "appid":            "105",
      "systemid":         "Naukri",
      "gid":              "LOCATION,INDUSTRY,EDUCATION,FAREA_ROLE",
      "x-requested-with": "XMLHttpRequest",
      "referer":          `${BASE_URL}/mnjuser/recommendedjobs`,
      "origin":           BASE_URL,
      "cookie":           this.cookieHeader,
      "user-agent":       "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    };
  }

  async fetchListings(): Promise<Job[]> {
    const { keywords, maxResults } = this.cfg.search;

    // Build searches array from configured keywords
    const searches = keywords.map((kw) => ({ keywords: kw.toLowerCase(), location: "" }));
    if (searches.length === 0) searches.push({ keywords: "software engineer", location: "" });

    const now = new Date();
    const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);

    const body = {
      clusterId: null,
      src: "recommClusterApi",
      clusterSplitDate: {
        apply:        fmt(now),
        preference:   "1980-01-01 05:30:00",
        profile:      fmt(new Date(now.getTime() - 22 * 24 * 60 * 60 * 1000)),
        similar_jobs: fmt(new Date(now.getTime() - 93 * 24 * 60 * 60 * 1000)),
        top_candidate:fmt(new Date(now.getTime() - 93 * 24 * 60 * 60 * 1000)),
      },
      searches,
    };

    this.log("Calling Naukri recommended jobs API…");

    const res = await axios.post<RecomResponse>(RECOM_API, body, {
      headers: this.apiHeaders(),
      timeout: 15000,
    });

    const raw = res.data.jobDetails ?? [];
    this.log(`API returned ${raw.length} jobs (total: ${res.data.noOfJobs})`);

    const jobs: Job[] = raw.slice(0, maxResults).map((item) => {
      const location = item.placeholders?.find((p) => p.type === "location")?.label ?? "";
      const jobUrl   = `${BASE_URL}${item.jdURL}`;
      const id       = crypto.createHash("md5").update(item.jobId).digest("hex");
      return {
        id,
        title:    item.title,
        company:  item.companyName,
        location,
        url:      jobUrl,
        source:   "naukri" as const,
        easyApply:true,
        tags:     item.tagsAndSkills?.split(",").map((s) => s.trim()),
        foundAt:  new Date().toISOString(),
      };
    }).filter((j) => this.matchesSearch(j));

    return jobs;
  }

  async applyToJob(job: Job): Promise<ApplicationResult> {
    if (hasApplied(job.id)) return { job, status: "already_applied" };

    try {
      // Extract numeric jobId from the hash — stored original in URL
      // Navigate to job page and apply via browser (handles questionnaires)
      await this.page.goto(job.url, { waitUntil: "load", timeout: 30000 });
      await delay(1500, 2500);

      const applyBtn = await this.page.$(
        '#apply-button, [id*="apply-button"], button[class*="applyBtn"], ' +
        'a[id*="apply"], div[class*="apply-button"] button'
      );

      if (!applyBtn) {
        this.log(`No apply button: ${job.title}`);
        return { job, status: "skipped" };
      }

      await applyBtn.click();
      await delay(2000, 3000);

      // Confirm modal if shown
      const confirmBtn = await this.page.$('button[class*="applyBtn"], button:has-text("Apply")');
      if (confirmBtn) {
        await confirmBtn.click();
        await delay(1500, 2500);
      }

      this.log(`✓ Applied: ${job.title} @ ${job.company}`);
      return { job, status: "applied", appliedAt: new Date().toISOString() };

    } catch (err) {
      return { job, status: "failed", error: err instanceof Error ? err.message : String(err) };
    }
  }
}
