import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const DATA_DIR = path.resolve("data");

// Sources that require manual browser login
const OAUTH_SOURCES = ["naukri", "linkedin", "indeed", "wellfound"];
// Sources that use public APIs — no login needed
const NO_LOGIN_SOURCES = ["greenhouse", "lever", "weworkremotely"];

export type AuthSource = "naukri" | "linkedin" | "indeed" | "wellfound";

const LOGIN_URLS: Record<AuthSource, string> = {
  naukri:   "https://www.naukri.com/nlogin/login",
  linkedin: "https://www.linkedin.com/login",
  indeed:   "https://secure.indeed.com/auth",
  wellfound:"https://wellfound.com/login",
};

// URL patterns that indicate successful login
const SUCCESS_URL: Record<AuthSource, (url: string) => boolean> = {
  naukri:   (u) => !u.includes("/nlogin/"),
  linkedin: (u) => u.includes("/feed") || u.includes("/in/"),
  indeed:   (u) => u.includes("indeed.com") && !u.includes("/auth"),
  wellfound:(u) => u.includes("wellfound.com") && !u.includes("/login"),
};

export function cookiePath(source: string): string {
  return path.join(DATA_DIR, `${source}_cookies.json`);
}

export function isConnected(source: string): boolean {
  if (NO_LOGIN_SOURCES.includes(source)) return true;
  const p = cookiePath(source);
  if (!fs.existsSync(p)) return false;
  // treat as expired after 7 days
  const age = Date.now() - fs.statSync(p).mtimeMs;
  return age < 7 * 24 * 60 * 60 * 1000;
}

export function getAuthStatus(): Record<string, { connected: boolean; noLoginNeeded: boolean; label: string }> {
  return {
    linkedin:       { connected: isConnected("linkedin"),  noLoginNeeded: false, label: "LinkedIn" },
    indeed:         { connected: isConnected("indeed"),    noLoginNeeded: false, label: "Indeed" },
    naukri:         { connected: isConnected("naukri"),    noLoginNeeded: false, label: "Naukri" },
    wellfound:      { connected: isConnected("wellfound"), noLoginNeeded: false, label: "Wellfound" },
    greenhouse:     { connected: true, noLoginNeeded: true, label: "Greenhouse" },
    lever:          { connected: true, noLoginNeeded: true, label: "Lever" },
    weworkremotely: { connected: true, noLoginNeeded: true, label: "WeWorkRemotely" },
  };
}

export async function loginWithBrowser(
  source: AuthSource,
  onLog: (msg: string) => void
): Promise<void> {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  try {
    onLog(`Opening ${source} login page…`);
    await page.goto(LOGIN_URLS[source], { waitUntil: "load", timeout: 30000 });
    onLog(`Log in using Google or your credentials in the browser window that just opened`);
    onLog(`Waiting up to 2 minutes…`);

    await page.waitForURL((url) => SUCCESS_URL[source](url.href), { timeout: 120000 });

    // Extra wait for session cookies to settle
    await page.waitForTimeout(2000);

    const cookies = await context.cookies();
    fs.writeFileSync(cookiePath(source), JSON.stringify(cookies, null, 2));
    onLog(`✓ Logged in to ${source} — session saved`);
  } finally {
    await context.close();
    await browser.close();
  }
}

export function disconnect(source: string): void {
  const p = cookiePath(source);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
