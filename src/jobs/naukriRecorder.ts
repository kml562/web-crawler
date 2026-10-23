/**
 * NaukriRecorder — opens a visible browser, watches what the user does,
 * saves every click/fill/navigate as a replay-able step list.
 *
 * Saved to: data/naukri_apply_flow.json
 * Replayed by: NaukriReplayer
 */

import { chromium, type Page, type BrowserContext } from "playwright";
import fs from "fs";
import { cookiePath } from "../auth/loginManager.js";
import { logger } from "../utils/logger.js";

const FLOW_PATH = "data/naukri_apply_flow.json";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";

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

export class NaukriRecorder {
  private page!: Page;
  private context!: BrowserContext;
  private steps: RecordedStep[] = [];
  private running = false;
  private onStep?: (step: RecordedStep) => void;

  setStepCallback(cb: (step: RecordedStep) => void) { this.onStep = cb; }

  async start(startUrl = "https://www.naukri.com"): Promise<void> {
    const cookieFile = cookiePath("naukri");
    const browser = await chromium.launch({ headless: false, slowMo: 50 });
    this.context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 800 } });

    // Load saved cookies so the user is already logged in
    if (fs.existsSync(cookieFile)) {
      const cookies = JSON.parse(fs.readFileSync(cookieFile, "utf-8"));
      await this.context.addCookies(cookies);
    }

    // Inject the recorder script before every page load
    await this.context.addInitScript(`
      (() => {
        // ── Selector generator ──────────────────────────────
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
          // CSS path fallback (up to 3 levels)
          let path = tag + type;
          let p = el.parentElement;
          let depth = 0;
          while (p && p.tagName !== 'BODY' && depth < 3) {
            const pTag = p.tagName.toLowerCase();
            if (p.id) { path = '#' + p.id + ' > ' + path; break; }
            const cls = Array.from(p.classList).filter(c => c.length < 30).slice(0,2).join('.');
            path = pTag + (cls ? '.' + cls : '') + ' ' + path;
            p = p.parentElement;
            depth++;
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

        // ── Recording overlay ───────────────────────────────
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

        function mount() {
          if (!document.getElementById('__nk_recorder')) {
            document.body?.prepend(overlay);
          }
        }
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', mount);
        } else { mount(); }

        let stepCount = 0;
        function bump() {
          stepCount++;
          const el = document.getElementById('__nk_step_count');
          if (el) el.textContent = stepCount + ' steps';
        }

        // ── Event listeners ─────────────────────────────────
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
    `);

    this.page = await this.context.newPage();

    // Bridge: page JS → Node.js
    await this.page.exposeFunction("__nk_record_navigate", (url: string) => {
      const step: RecordedStep = { type: "navigate", url };
      this.steps.push(step);
      this.onStep?.(step);
      logger.info(`[Recorder] navigate → ${url}`, { service: "recorder" });
    });

    await this.page.exposeFunction("__nk_record_click", (selector: string, text: string, url: string) => {
      // Ignore clicks on trivial elements
      if (!text && !selector) return;
      const step: RecordedStep = { type: "click", selector, text, url };
      this.steps.push(step);
      this.onStep?.(step);
      logger.info(`[Recorder] click "${text}" (${selector})`, { service: "recorder" });
    });

    await this.page.exposeFunction("__nk_record_fill", (selector: string, value: string, label: string, url: string) => {
      if (!value) return;
      const step: RecordedStep = { type: "fill", selector, value, label, url };
      this.steps.push(step);
      this.onStep?.(step);
      logger.info(`[Recorder] fill "${label}" = "${value.slice(0, 30)}"`, { service: "recorder" });
    });

    await this.page.exposeFunction("__nk_record_select", (selector: string, value: string, label: string, url: string) => {
      const step: RecordedStep = { type: "select", selector, value, label, url };
      this.steps.push(step);
      this.onStep?.(step);
      logger.info(`[Recorder] select "${label}" = "${value}"`, { service: "recorder" });
    });

    this.running = true;
    await this.page.goto(startUrl, { waitUntil: "domcontentloaded" });
    logger.info("[Recorder] Browser opened — do your apply flow now", { service: "recorder" });
  }

  async stop(): Promise<ApplyFlow> {
    this.running = false;

    // Save updated cookies (session may have refreshed)
    try {
      const cookies = await this.context.cookies();
      fs.mkdirSync("data", { recursive: true });
      fs.writeFileSync(cookiePath("naukri"), JSON.stringify(cookies, null, 2));
    } catch { /* ignore */ }

    const flow: ApplyFlow = {
      recordedAt: new Date().toISOString(),
      startUrl:   this.steps.find((s) => s.type === "navigate")?.url ?? "https://www.naukri.com",
      steps:      this.steps,
      notes:      "Recorded via Learn Mode. Template vars: {{yearsOfExperience}}, {{noticePeriod}}, {{currentCTC}}, {{expectedCTC}}",
    };

    fs.mkdirSync("data", { recursive: true });
    fs.writeFileSync(FLOW_PATH, JSON.stringify(flow, null, 2));
    logger.info(`[Recorder] Saved ${this.steps.length} steps to ${FLOW_PATH}`, { service: "recorder" });

    await this.context.close().catch(() => {});
    return flow;
  }

  getSteps()     { return this.steps; }
  isRunning()    { return this.running; }
}

export { FLOW_PATH };
