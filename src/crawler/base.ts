import type { Page, BrowserContext } from "playwright";
import type { Job, ApplicationResult, JobsConfig } from "../types/index.js";
import { newPage } from "./browser.js";
import { logger } from "../utils/logger.js";
import { delay } from "../utils/delay.js";
import { loadProfile } from "../utils/profile.js";

export abstract class BaseScraper {
  protected page!: Page;
  protected context!: BrowserContext;
  protected cfg: JobsConfig;
  pagesVisited = 0;  // incremented by safeGoto, readable by server
  private logCallback?: (msg: string) => void;

  constructor(cfg: JobsConfig) {
    this.cfg = cfg;
  }

  /** Wire up a callback so scraper-internal logs appear in the UI via SSE */
  setLogCallback(cb: (msg: string) => void): void {
    this.logCallback = cb;
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
    this.pagesVisited++;
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

  // Detect if page has redirected to an external company ATS (Workday, BambooHR, etc.)
  protected isExternalATS(): boolean {
    const url = this.page.url();
    const externalATS = ["myworkdayjobs.com", "bamboohr.com", "workday.com", "icims.com",
      "taleo.net", "smartrecruiters.com", "jobvite.com", "ashbyhq.com", "rippling.com/jobs"];
    return externalATS.some((ats) => url.includes(ats));
  }

  // Fill common screening questions found on most application forms
  protected async fillScreeningQuestions(): Promise<void> {
    const profile = loadProfile();
    const p = this.page;

    // Helper: try to fill a visible input matching label text
    const fillByLabel = async (labelTexts: string[], value: string) => {
      if (!value) return;
      for (const text of labelTexts) {
        const lower = text.toLowerCase();
        for (const selector of [
          `input[aria-label*="${text}" i]`,
          `input[placeholder*="${text}" i]`,
          `textarea[placeholder*="${text}" i]`,
          `input[name*="${lower.replace(/\s/g, "_")}"]`,
          `input[name*="${lower.replace(/\s/g, "")}"]`,
        ]) {
          const el = await p.$(selector);
          if (el && await el.isVisible()) {
            await el.fill(value);
            await delay(200, 400);
            return;
          }
        }
      }
    };

    // Helper: select option in dropdown by visible text (using Playwright locator)
    const selectByLabel = async (labelTexts: string[], optionText: string) => {
      if (!optionText) return;
      for (const text of labelTexts) {
        const selects = await p.$$("select");
        for (const sel of selects) {
          // Get the associated label text via Playwright's evaluate (inside page context)
          const labelText = await sel.evaluate((el: Element) => {
            const id = (el as HTMLSelectElement).id;
            const lbl = id ? (el.ownerDocument as Document).querySelector(`label[for="${id}"]`) : null;
            return lbl?.textContent ?? (el as HTMLSelectElement).getAttribute("aria-label") ?? "";
          });
          if (labelText.toLowerCase().includes(text.toLowerCase())) {
            await sel.selectOption({ label: optionText }).catch(() =>
              sel.selectOption({ value: optionText }).catch(() => {})
            );
            await delay(200, 400);
            return;
          }
        }
      }
    };

    await fillByLabel(["years of experience", "total experience", "experience (years)", "work experience"], String(profile.yearsOfExperience));
    await fillByLabel(["notice period", "notice"], profile.noticePeriod);
    await fillByLabel(["current ctc", "current salary", "current package"], profile.currentCTC);
    await fillByLabel(["expected ctc", "expected salary", "expected package"], profile.expectedCTC);
    await fillByLabel(["current location", "current city"], "Bengaluru");
    await fillByLabel(["preferred location", "preferred city"], "Bengaluru, Remote");

    await selectByLabel(["notice period"], profile.noticePeriod);
    await selectByLabel(["willing to relocate", "relocate"], profile.willingToRelocate);
    await selectByLabel(["work authorization", "visa status"], profile.workAuthorization);

    // Radio buttons: "Are you willing to relocate?" → Yes
    const relocateRadios = await p.$$('input[type="radio"]');
    for (const radio of relocateRadios) {
      const label = await radio.evaluate((el: Element) => {
        const input = el as HTMLInputElement;
        const lbl = (el.ownerDocument as Document).querySelector(`label[for="${input.id}"]`);
        return lbl?.textContent?.trim().toLowerCase() ?? "";
      });
      if (label === "yes" || label === "bengaluru") {
        await radio.check().catch(() => {});
        await delay(100, 200);
      }
    }
  }

  protected log(msg: string): void {
    const full = `[${this.constructor.name}] ${msg}`;
    logger.info(full);
    this.logCallback?.(full);
  }
}
