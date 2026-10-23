/**
 * NaukriReplayer — loads the flow recorded by NaukriRecorder and replays
 * it on a Playwright page, substituting profile values for template vars.
 */

import type { Page } from "playwright";
import fs from "fs";
import { FLOW_PATH, type ApplyFlow, type RecordedStep } from "./naukriRecorder.js";
import { loadProfile } from "../utils/profile.js";
import { delay } from "../utils/delay.js";
import { logger } from "../utils/logger.js";

export function hasRecordedFlow(): boolean {
  return fs.existsSync(FLOW_PATH);
}

export function loadFlow(): ApplyFlow | null {
  try {
    return JSON.parse(fs.readFileSync(FLOW_PATH, "utf-8")) as ApplyFlow;
  } catch {
    return null;
  }
}

function substituteVars(value: string): string {
  const profile = loadProfile();
  return value
    .replace(/\{\{yearsOfExperience\}\}/g, String(profile.yearsOfExperience ?? ""))
    .replace(/\{\{noticePeriod\}\}/g,      profile.noticePeriod      ?? "")
    .replace(/\{\{currentCTC\}\}/g,        profile.currentCTC        ?? "")
    .replace(/\{\{expectedCTC\}\}/g,       profile.expectedCTC       ?? "")
    .replace(/\{\{firstName\}\}/g,         profile.firstName ?? "")
    .replace(/\{\{lastName\}\}/g,          profile.lastName  ?? "")
    .replace(/\{\{email\}\}/g,             profile.email             ?? "")
    .replace(/\{\{phone\}\}/g,             profile.phone             ?? "");
}

export async function replayFlow(
  page: Page,
  jobUrl: string,
  log: (msg: string) => void
): Promise<"applied" | "failed" | "skipped"> {
  const flow = loadFlow();
  if (!flow || flow.steps.length === 0) {
    log("No recorded flow found");
    return "failed";
  }

  log(`Replaying ${flow.steps.length} recorded steps (recorded ${flow.recordedAt.slice(0, 10)})`);

  // Navigate to the actual job URL first (the recorded flow had a specific job URL,
  // but we replace it with the current job's URL for the first navigate)
  let replacedFirstNav = false;

  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i];

    try {
      switch (step.type) {
        case "navigate": {
          let url = step.url;
          // Replace the first job-page navigate with the actual job URL
          if (!replacedFirstNav && /naukri\.com\/(job-listings|[^/]+-jid-)/.test(url)) {
            url = jobUrl;
            replacedFirstNav = true;
          }
          log(`[${i + 1}/${flow.steps.length}] Navigate → ${url.slice(0, 80)}`);
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
          await delay(1500, 2500);
          break;
        }

        case "click": {
          log(`[${i + 1}/${flow.steps.length}] Click "${step.text}" (${step.selector})`);
          // Try the exact recorded selector first, then text fallback
          const clicked = await tryClick(page, step.selector, step.text);
          if (!clicked) {
            log(`  ↳ selector missed — skipping this step`);
          }
          await delay(800, 1500);
          break;
        }

        case "fill": {
          const val = substituteVars(step.value);
          log(`[${i + 1}/${flow.steps.length}] Fill "${step.label}" = "${val.slice(0, 30)}"`);
          const filled = await tryFill(page, step.selector, val);
          if (!filled) log(`  ↳ fill target not found — skipping`);
          await delay(300, 600);
          break;
        }

        case "select": {
          const val = substituteVars(step.value);
          log(`[${i + 1}/${flow.steps.length}] Select "${step.label}" = "${val}"`);
          await page.selectOption(step.selector, { value: val })
            .catch(() => page.selectOption(step.selector, { label: val }).catch(() => {}));
          await delay(300, 600);
          break;
        }

        case "wait": {
          log(`[${i + 1}/${flow.steps.length}] Wait ${step.ms}ms`);
          await delay(step.ms, step.ms + 500);
          break;
        }
      }
    } catch (err) {
      log(`  ↳ Step ${i + 1} error: ${err instanceof Error ? err.message : String(err)} — continuing`);
    }
  }

  // Check for success markers on the final page
  const bodyText = await page.$eval("body", (b) => b.innerText).catch(() => "");
  if (/already applied/i.test(bodyText)) return "skipped";
  if (/applied successfully|application submitted|you.ve applied/i.test(bodyText)) return "applied";

  log("Replay complete");
  return "applied"; // optimistic — the flow ran to completion
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function tryClick(page: Page, selector: string, text: string): Promise<boolean> {
  // 1. Exact recorded selector
  try {
    const el = await page.$(selector);
    if (el && await el.isVisible()) { await el.click(); return true; }
  } catch { /* try next */ }

  // 2. Text-based fallback
  if (text) {
    for (const tag of ["button", "a", "span", "div"]) {
      try {
        const el = await page.$(`${tag}:has-text("${text.slice(0, 40)}")`);
        if (el && await el.isVisible()) { await el.click(); return true; }
      } catch { /* try next */ }
    }
  }
  return false;
}

async function tryFill(page: Page, selector: string, value: string): Promise<boolean> {
  try {
    const el = await page.$(selector);
    if (el && await el.isVisible()) { await el.fill(value); return true; }
  } catch { /* try next */ }
  return false;
}
