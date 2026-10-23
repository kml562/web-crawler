/**
 * NaukriRecorder — opens a visible browser, watches what the user does on
 * ANY tab, saves every click/fill/navigate as a replay-able step list.
 *
 * Saved to: data/naukri_apply_flow.json
 * Replayed by: NaukriReplayer
 */

import { chromium, type Page, type BrowserContext, type Browser } from "playwright";
import fs from "fs";
import { cookiePath } from "../auth/loginManager.js";
import { logger } from "../utils/logger.js";

export const FLOW_PATH            = "data/naukri_apply_flow.json";
export const DISCOVERED_JOBS_PATH = "data/naukri_discovered_jobs.json";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";

export interface DiscoveredJob {
  title:   string;
  company: string;
  location: string;
  url:     string;
  jobId:   string;
}

export type RecordedStep =
  | { type: "navigate"; url: string }
  | { type: "click";    selector: string; text: string; url: string }
  | { type: "fill";     selector: string; value: string; label: string; url: string }
  | { type: "select";   selector: string; value: string; label: string; url: string }
  | { type: "wait";     ms: number };

export interface ApplyFlow {
  recordedAt: string;
  startUrl:   string;
  steps:      RecordedStep[];
  notes:      string;
}

// Injected into every page — generates robust selectors and records events
const RECORDER_SCRIPT = `
(() => {
  if (window.__nk_recorder_loaded) return;
  window.__nk_recorder_loaded = true;

  function bestSelector(el) {
    if (el.id) return '#' + el.id;
    if (el.dataset && el.dataset.qa) return '[data-qa="' + el.dataset.qa + '"]';
    if (el.dataset && el.dataset.testid) return '[data-testid="' + el.dataset.testid + '"]';
    const tag = el.tagName.toLowerCase();
    const type = el.type ? '[type="' + el.type + '"]' : '';
    const name = el.name ? '[name="' + el.name + '"]' : '';
    const ph   = el.placeholder ? '[placeholder*="' + el.placeholder.slice(0,20) + '"]' : '';
    const text = el.textContent?.trim().slice(0, 40);
    if (tag === 'button' && text) return 'button:has-text("' + text + '")';
    if (tag === 'a' && text) return 'a:has-text("' + text + '")';
    if (name)  return tag + name;
    if (ph)    return tag + ph;
    let path = tag + type;
    let p = el.parentElement;
    let depth = 0;
    while (p && p.tagName !== 'BODY' && depth < 3) {
      const pTag = p.tagName.toLowerCase();
      if (p.id) { path = '#' + p.id + ' > ' + path; break; }
      const cls = Array.from(p.classList).filter(c => c.length < 30).slice(0,2).join('.');
      path = pTag + (cls ? '.' + cls : '') + ' ' + path;
      p = p.parentElement; depth++;
    }
    return path;
  }

  function labelFor(el) {
    if (el.id) {
      const lbl = document.querySelector('label[for="' + el.id + '"]');
      if (lbl) return lbl.textContent?.trim() ?? '';
    }
    const wrap = el.closest('label');
    return wrap?.textContent?.trim().slice(0, 60) ?? el.placeholder ?? el.name ?? '';
  }

  // Red overlay banner
  const overlay = document.createElement('div');
  overlay.id = '__nk_recorder';
  overlay.style.cssText = [
    'position:fixed','top:0','left:0','right:0','z-index:999999',
    'background:rgba(220,38,38,0.92)','color:#fff','font-family:monospace',
    'font-size:13px','padding:8px 16px','display:flex','align-items:center',
    'gap:12px','box-shadow:0 2px 8px rgba(0,0,0,.4)'
  ].join(';');
  overlay.innerHTML = '<span style="font-size:18px">⏺</span>'
    + '<strong>Recording your actions…</strong>'
    + '<span id="__nk_step_count" style="opacity:.8">0 steps</span>'
    + '<span style="margin-left:auto;opacity:.7">Close tab or click Stop in dashboard when done</span>';

  function mountOverlay() {
    if (!document.getElementById('__nk_recorder')) document.body?.prepend(overlay);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountOverlay);
  else mountOverlay();

  let stepCount = 0;
  function bump() {
    stepCount++;
    const el = document.getElementById('__nk_step_count');
    if (el) el.textContent = stepCount + ' steps';
  }

  // URL change watcher
  let lastNav = location.href;
  setInterval(() => {
    if (location.href !== lastNav) {
      lastNav = location.href;
      if (window.__nk_record_navigate) window.__nk_record_navigate(location.href);
      bump();
    }
  }, 500);

  document.addEventListener('click', (e) => {
    const el = e.target;
    if (!el || el === overlay || overlay.contains(el)) return;
    const sel = bestSelector(el);
    const text = el.textContent?.trim().slice(0, 60) ?? '';
    if (window.__nk_record_click) window.__nk_record_click(sel, text, location.href);
    bump();
  }, true);

  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!el) return;
    const tag = el.tagName?.toLowerCase();
    const sel = bestSelector(el);
    const val = el.value ?? '';
    const lbl = labelFor(el);
    if (tag === 'select') {
      if (window.__nk_record_select) window.__nk_record_select(sel, val, lbl, location.href);
    } else if (tag === 'input' || tag === 'textarea') {
      if (window.__nk_record_fill) window.__nk_record_fill(sel, val, lbl, location.href);
    }
    bump();
  }, true);
})();
`;

export class NaukriRecorder {
  private browser!: Browser;
  private context!: BrowserContext;
  private steps: RecordedStep[] = [];
  private running = false;
  private onStep?: (step: RecordedStep) => void;

  setStepCallback(cb: (step: RecordedStep) => void) { this.onStep = cb; }

  private async setupPage(page: Page): Promise<void> {
    await page.exposeFunction("__nk_record_navigate", (url: string) => {
      const step: RecordedStep = { type: "navigate", url };
      this.steps.push(step);
      this.onStep?.(step);
    }).catch(() => {}); // may already be exposed on re-used page

    await page.exposeFunction("__nk_record_click", (selector: string, text: string, url: string) => {
      if (!text && !selector) return;
      const step: RecordedStep = { type: "click", selector, text, url };
      this.steps.push(step);
      this.onStep?.(step);
    }).catch(() => {});

    await page.exposeFunction("__nk_record_fill", (selector: string, value: string, label: string, url: string) => {
      if (!value) return;
      const step: RecordedStep = { type: "fill", selector, value, label, url };
      this.steps.push(step);
      this.onStep?.(step);
    }).catch(() => {});

    await page.exposeFunction("__nk_record_select", (selector: string, value: string, label: string, url: string) => {
      const step: RecordedStep = { type: "select", selector, value, label, url };
      this.steps.push(step);
      this.onStep?.(step);
    }).catch(() => {});
  }

  async start(startUrl = "https://www.naukri.com"): Promise<void> {
    this.browser = await chromium.launch({ headless: false, slowMo: 50 });
    this.context = await this.browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 800 } });

    // Load saved cookies
    const cookieFile = cookiePath("naukri");
    if (fs.existsSync(cookieFile)) {
      const cookies = JSON.parse(fs.readFileSync(cookieFile, "utf-8"));
      await this.context.addCookies(cookies);
    }

    // Inject recorder into every page (including new tabs)
    await this.context.addInitScript(RECORDER_SCRIPT);

    // Setup bridge functions for every new page that opens
    this.context.on("page", async (page) => {
      await this.setupPage(page);
    });

    // Auto-stop if user closes the browser window
    this.browser.on("disconnected", () => {
      if (this.running) {
        logger.info("[Recorder] Browser closed by user — stopping", { service: "recorder" });
        this.running = false;
        this._saveCookies().catch(() => {});
      }
    });

    this.running = true;
    const firstPage = await this.context.newPage();
    await this.setupPage(firstPage);
    await firstPage.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    logger.info("[Recorder] Browser opened — do your apply flow now", { service: "recorder" });
  }

  async stop(): Promise<ApplyFlow> {
    this.running = false;
    await this._saveCookies();

    const flow: ApplyFlow = {
      recordedAt: new Date().toISOString(),
      startUrl:   this.steps.find((s) => s.type === "navigate")?.url ?? "https://www.naukri.com",
      steps:      this.steps,
      notes:      "Recorded via Learn Mode. Template vars: {{yearsOfExperience}}, {{noticePeriod}}, {{currentCTC}}, {{expectedCTC}}",
    };

    fs.mkdirSync("data", { recursive: true });
    fs.writeFileSync(FLOW_PATH, JSON.stringify(flow, null, 2));
    logger.info(`[Recorder] Saved ${this.steps.length} steps to ${FLOW_PATH}`, { service: "recorder" });

    // Close with timeout — browser may already be closed by user
    await Promise.race([
      this.context.close().catch(() => {}),
      new Promise<void>((r) => setTimeout(r, 3000)),
    ]);

    return flow;
  }

  private async _saveCookies(): Promise<void> {
    try {
      const cookies = await this.context.cookies();
      fs.mkdirSync("data", { recursive: true });
      fs.writeFileSync(cookiePath("naukri"), JSON.stringify(cookies, null, 2));
    } catch { /* context already gone */ }
  }

  // Search Naukri using the recorder's own open browser and capture job links.
  // Exactly mirrors the Python bot: navigates each keyword page, scrapes
  // div.srp-jobtuple-wrapper a.title — returns the number of jobs saved.
  async searchAndCapture(
    keywords: string[],
    pagesPerKeyword: number,
    onLog: (msg: string) => void
  ): Promise<DiscoveredJob[]> {
    const pages = await this.context.pages();
    const page  = pages[0]; // use the tab that is already open on Naukri

    const allJobs: DiscoveredJob[] = [];

    for (const keyword of keywords) {
      const slug = keyword
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .trim()
        .replace(/\s+/g, "-") + "-jobs";

      for (let pageNo = 1; pageNo <= pagesPerKeyword; pageNo++) {
        const suffix = pageNo === 1 ? "" : `-${pageNo}`;
        const url = `https://www.naukri.com/${slug}${suffix}?k=${encodeURIComponent(keyword)}&nignbevent_src=jobsearchDeskGNB`;

        onLog(`Searching: "${keyword}" page ${pageNo}…`);
        try {
          await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
        } catch {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
        }
        // Wait for React to render job cards
        await page.waitForSelector("div.srp-jobtuple-wrapper, div.cust-job-tuple", { timeout: 8000 }).catch(() => {});

        const jobs = await page.$$eval(
          "div.srp-jobtuple-wrapper, div.cust-job-tuple",
          (wrappers: Element[]) => wrappers.map((w) => {
            const titleEl   = w.querySelector("a.title") as HTMLAnchorElement | null;
            const companyEl = w.querySelector("a.subTitle, .subTitle") as HTMLElement | null;
            const locEl     = w.querySelector("span.locWdth, li.fleft.grey-text, span.loc, .location") as HTMLElement | null;
            const href      = titleEl?.href ?? titleEl?.getAttribute("href") ?? "";
            const full      = href.startsWith("/") ? "https://www.naukri.com" + href : href;
            const idMatch   = full.match(/jid-(\d+)/) ?? full.match(/-(\d{8,})[\/?]/);
            return {
              title:    titleEl?.textContent?.trim()   ?? "",
              company:  companyEl?.textContent?.trim() ?? "",
              location: locEl?.textContent?.trim()     ?? "",
              url:      full,
              jobId:    idMatch?.[1] ?? "",
            };
          }).filter((j: { title: string; url: string }) => j.title && j.url)
        ).catch(() => []) as DiscoveredJob[];

        onLog(`  → ${jobs.length} jobs found on page ${pageNo}`);
        allJobs.push(...jobs);
      }
    }

    // Deduplicate by URL
    const seen  = new Set<string>();
    const unique = allJobs.filter((j) => { if (seen.has(j.url)) return false; seen.add(j.url); return true; });

    fs.mkdirSync("data", { recursive: true });
    fs.writeFileSync(DISCOVERED_JOBS_PATH, JSON.stringify(unique, null, 2));
    onLog(`Saved ${unique.length} unique jobs to DB`);

    return unique;
  }

  getSteps()  { return this.steps; }
  isRunning() { return this.running; }
}
