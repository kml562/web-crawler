import type { Page, BrowserContext } from "playwright";
import type { Job, ApplicationResult, JobsConfig } from "../types/index.js";
import { newPage } from "./browser.js";
import { logger } from "../utils/logger.js";
import { delay } from "../utils/delay.js";

export abstract class BaseScraper {
  protected page!: Page;
  protected context!: BrowserContext;
  protected cfg: JobsConfig;

  constructor(cfg: JobsConfig) {
    this.cfg = cfg;
  }

  async init(): Promise<void> {
    const { page, context } = await newPage();
    this.page = page;
    this.context = context;
  }

  async close(): Promise<void> {
    await this.context.close();
  }

  abstract fetchListings(): Promise<Job[]>;
  abstract applyToJob(job: Job): Promise<ApplicationResult>;

  protected async safeGoto(url: string, waitUntil: "load" | "networkidle" = "networkidle"): Promise<void> {
    await this.page.goto(url, { waitUntil, timeout: 30000 });
    await delay(this.cfg.search ? 800 : 1000, 2000);
  }

  protected matchesSearch(job: Job): boolean {
    const { requiredKeywords, excludeKeywords, blacklistCompanies } = this.cfg.search;
    const text = `${job.title} ${job.description ?? ""}`.toLowerCase();

    if (blacklistCompanies.some((c) => job.company.toLowerCase().includes(c.toLowerCase()))) {
      return false;
    }
    if (excludeKeywords.some((kw) => text.includes(kw.toLowerCase()))) {
      return false;
    }
    if (requiredKeywords.length > 0 && !requiredKeywords.some((kw) => text.includes(kw.toLowerCase()))) {
      return false;
    }
    return true;
  }

  protected log(msg: string): void {
    logger.info(`[${this.constructor.name}] ${msg}`);
  }
}
