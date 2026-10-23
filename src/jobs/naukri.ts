import { BaseScraper } from "../crawler/base.js";
import type { Job, ApplicationResult, JobsConfig } from "../types/index.js";
import { delay } from "../utils/delay.js";
import { hasApplied } from "../tracker/storage.js";
import { loadProfile } from "../utils/profile.js";
import { cookiePath } from "../auth/loginManager.js";
import { upsertCareerPage } from "../tracker/careerPages.js";
import { hasRecordedFlow, replayFlow } from "./naukriReplayer.js";
import { chromium } from "playwright";
import axios from "axios";
import crypto from "crypto";
import fs from "fs";

const RECOM_API   = "https://www.naukri.com/jobapi/v2/search/recom-jobs";
const APPLY_API  = "https://www.naukri.com/cloudgateway-workflow/workflow-services/apply-workflow/v1/apply";
const CHATBOT_API = "https://www.naukri.com/cloudgateway-chatbot/chatbot-services/botapi/v5/respond";
const BASE_URL   = "https://www.naukri.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";

interface NaukriJob {
  jobId: string;
  title: string;
  companyName: string;
  jdURL: string;
  tagsAndSkills?: string;
  mandatorySkills?: string[];
  optionalSkills?: string[];
  placeholders?: Array<{ type: string; label: string }>;
  // company profile / career page fields returned by Naukri API
  companyId?: string;
  staticUrl?: string;       // Naukri company profile path, e.g. "/company/acme-jobs"
  companyUrl?: string;      // official company website URL (sometimes returned)
  companyCareerUrl?: string; // direct careers page URL (sometimes returned)
  companyInfo?: { websiteUrl?: string; careerPageUrl?: string };
}

interface RecomResponse {
  noOfJobs: number;
  jobDetails: NaukriJob[];
}

interface ApplyResponse {
  data?: {
    isChatBot?: boolean;
    chatBotData?: unknown;
    message?: string;
  };
  status?: number;
}

interface ChatbotMessage {
  id?: string;
  text?: string;
  type?: string; // "text" | "radio" | "checkbox" | "number"
  options?: Array<{ id: string; text: string; value?: string }>;
  isComplete?: boolean;
  completed?: boolean;
}

interface ChatbotResponse {
  msg?: string;
  message?: string;
  messages?: ChatbotMessage[];
  data?: {
    messages?: ChatbotMessage[];
    isComplete?: boolean;
    nextQuestion?: ChatbotMessage;
  };
  isComplete?: boolean;
  complete?: boolean;
  status?: string;
}

export class NaukriScraper extends BaseScraper {
  private cookieHeader = "";
  private accessToken  = "";

  constructor(cfg: JobsConfig) {
    super(cfg);
  }

  private loadSession(): void {
    const cp = cookiePath("naukri");
    if (!fs.existsSync(cp)) return;
    const cookies: Array<{ name: string; value: string }> = JSON.parse(fs.readFileSync(cp, "utf-8"));
    this.cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    // Extract JWT from nauk_at cookie
    const atCookie = cookies.find((c) => c.name === "nauk_at");
    if (atCookie) this.accessToken = atCookie.value;
  }

  async init(): Promise<void> {
    this.loadSession();

    if (!this.cookieHeader) {
      throw new Error("Naukri session not found. Please connect your Naukri account first from the Profile tab.");
    }

    const headless = this.cfg.showBrowser !== true;
    if (!headless) this.log("Opening visible browser (Show Browser is ON)");
    const browser = await chromium.launch({ headless });
    const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 800 } });
    const cookies: Array<{ name: string; value: string; domain: string; path: string }> =
      JSON.parse(fs.readFileSync(cookiePath("naukri"), "utf-8"));
    await context.addCookies(cookies);
    this.page    = await context.newPage();
    this.context = context;

    this.log("Naukri session loaded");
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

  private recomHeaders() {
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
      "user-agent":       UA,
    };
  }

  private applyHeaders() {
    return {
      "accept":          "application/json",
      "content-type":    "application/json",
      "appid":           "121",
      "clientid":        "d3skt0p",
      "systemid":        "jobseeker",
      "authorization":   `ACCESSTOKEN = ${this.accessToken}`,
      "cache-control":   "max-age=0",
      "origin":          BASE_URL,
      "referer":         BASE_URL,
      "user-agent":      UA,
      "cookie":          this.cookieHeader,
    };
  }

  private chatbotHeaders() {
    return {
      "accept":        "application/json",
      "content-type":  "application/json",
      "authorization": `Bearer ${this.accessToken}`,
      "origin":        BASE_URL,
      "referer":       BASE_URL,
      "user-agent":    UA,
      "cookie":        this.cookieHeader,
    };
  }

  async fetchListings(): Promise<Job[]> {
    const { keywords, maxResults } = this.cfg.search;
    const profile   = loadProfile();
    const experience = profile.yearsOfExperience || 5;

    // Primary keyword for SEO slug + ?k= param (use first keyword or default)
    const primaryKw = keywords[0] ?? "backend developer, node.js";
    // Build the SEO slug: "node js developer" → "node-js-developer-jobs"
    const seoSlug = primaryKw
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .trim()
      .replace(/\s+/g, "-") + "-jobs";

    const kParam  = encodeURIComponent(primaryKw);
    const expParam = `experience=${experience}`;

    const allRaw: NaukriJob[] = [];
    const PAGE_SIZE = 20;

    for (let pageNo = 1; allRaw.length < maxResults; pageNo++) {
      // Naukri URL pattern: /slug?k=...   for page 1
      //                     /slug-2?k=... for page 2, etc.
      const pageSuffix = pageNo === 1 ? "" : `-${pageNo}`;
      const pageUrl = `${BASE_URL}/${seoSlug}${pageSuffix}?k=${kParam}&${expParam}&nignbevent_src=jobsearchDeskGNB`;

      this.log(`Navigating to search page ${pageNo}… (${allRaw.length}/${maxResults} so far)`);
      this.log(`URL: ${pageUrl}`);

      let intercepted: NaukriJob[] | null = null;

      // Intercept /jobapi/v3/search response the page fires naturally —
      // the browser session handles all auth cookies automatically.
      const apiCapture = new Promise<void>((resolve) => {
        this.page.on("response", async function handler(response) {
          if (!response.url().includes("/jobapi/v3/search")) return;
          try {
            const json = await response.json() as RecomResponse;
            intercepted = json.jobDetails ?? [];
          } catch { intercepted = []; }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (response.frame().page() as any).off("response", handler);
          resolve();
        });
      });

      try {
        await this.page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      } catch (err) {
        this.log(`Navigation error on page ${pageNo}: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }

      // Wait up to 8s for the API call to complete after page load
      await Promise.race([
        apiCapture,
        new Promise<void>((resolve) => setTimeout(resolve, 8000)),
      ]);

      // If intercept didn't fire, scrape job cards from the DOM as fallback
      if (!intercepted) {
        this.log(`API intercept missed on page ${pageNo}, falling back to DOM scrape`);
        intercepted = await this.scrapePageDOM();
      }

      const batch = intercepted ?? [];
      this.log(`Page ${pageNo}: ${batch.length} jobs found`);

      if (batch.length === 0 && pageNo === 1) {
        this.log("No jobs captured on page 1 — falling back to recommended jobs API");
        return this.fetchRecommended(maxResults);
      }
      if (batch.length === 0) break;
      allRaw.push(...batch);
      if (batch.length < PAGE_SIZE) break; // Naukri ran out of results
      await delay(1500, 2500);
    }

    this.log(`Total collected: ${allRaw.length} jobs`);

    const jobs = allRaw.slice(0, maxResults)
      .map((item) => this.mapNaukriItem(item))
      .filter((j) => this.matchesNaukri(j));

    const withCareer = jobs.filter((j) => j.companyCareerUrl).length;
    if (withCareer > 0) this.log(`Career pages discovered: ${withCareer} companies`);

    return jobs;
  }

  // DOM scrape fallback — reads job cards directly from the search results page
  private async scrapePageDOM(): Promise<NaukriJob[]> {
    try {
      return await this.page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll("article.jobTuple, div.srp-jobtuple-wrapper, div[class*='jobTupleHeader']"));
        return cards.map((card) => {
          const titleEl  = card.querySelector("a.title, a[class*='title']");
          const compEl   = card.querySelector("a.subTitle, a[class*='companyInfo'], span[class*='company']");
          const locEl    = card.querySelector("span[class*='location'], li[class*='location']");
          const href     = titleEl?.getAttribute("href") ?? "";
          // extract jobId from URL like /job-listings-...-jid-12345678
          const jobIdMatch = href.match(/jid-(\d+)/i) ?? href.match(/-(\d+)\?/);
          return {
            jobId:       jobIdMatch?.[1] ?? String(Math.random()),
            title:       titleEl?.textContent?.trim() ?? "",
            companyName: compEl?.textContent?.trim()  ?? "",
            jdURL:       href.startsWith("http") ? new URL(href).pathname : href,
            placeholders: locEl ? [{ type: "location", label: locEl.textContent?.trim() ?? "" }] : [],
          };
        }).filter((j) => j.title && j.companyName);
      });
    } catch {
      return [];
    }
  }

  private mapNaukriItem(item: NaukriJob): Job {
    const location = item.placeholders?.find((p) => p.type === "location")?.label ?? "";
    const id       = crypto.createHash("md5").update(item.jobId).digest("hex");
    const officialCareerUrl =
      item.companyInfo?.careerPageUrl ??
      item.companyCareerUrl ??
      item.companyInfo?.websiteUrl ??
      item.companyUrl ??
      undefined;
    const naukriProfileUrl = item.staticUrl ? `${BASE_URL}${item.staticUrl}` : undefined;

    upsertCareerPage({ company: item.companyName, naukriProfileUrl, officialCareerUrl, source: "naukri" });

    return {
      id,
      naukriJobId:      item.jobId,
      mandatorySkills:  item.mandatorySkills ?? [],
      optionalSkills:   item.optionalSkills  ?? [],
      title:            item.title,
      company:          item.companyName,
      location,
      url:              `${BASE_URL}${item.jdURL}`,
      source:           "naukri" as const,
      easyApply:        true,
      tags:             item.tagsAndSkills?.split(",").map((s) => s.trim()),
      description:      [item.tagsAndSkills, ...(item.mandatorySkills ?? []), ...(item.optionalSkills ?? [])].filter(Boolean).join(" "),
      companyCareerUrl: officialCareerUrl ?? naukriProfileUrl,
      foundAt:          new Date().toISOString(),
    };
  }

  // Fallback: recommended jobs API (used when keyword search returns 401/403)
  private async fetchRecommended(maxResults: number): Promise<Job[]> {
    const { keywords } = this.cfg.search;
    const searches = keywords.map((kw) => ({ keywords: kw.toLowerCase(), location: "" }));
    if (searches.length === 0) searches.push({ keywords: "node.js backend engineer", location: "" });

    const now = new Date();
    const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);
    const body = {
      clusterId: null,
      src: "recommClusterApi",
      clusterSplitDate: {
        apply:         fmt(now),
        preference:    "1980-01-01 05:30:00",
        profile:       fmt(new Date(now.getTime() - 22 * 24 * 60 * 60 * 1000)),
        similar_jobs:  fmt(new Date(now.getTime() - 93 * 24 * 60 * 60 * 1000)),
        top_candidate: fmt(new Date(now.getTime() - 93 * 24 * 60 * 60 * 1000)),
      },
      searches,
    };

    this.log("Falling back to recommended jobs API…");
    const res = await axios.post<RecomResponse>(RECOM_API, body, {
      headers: this.recomHeaders(), timeout: 15000,
    });

    const raw = res.data.jobDetails ?? [];
    this.log(`Recom API returned ${raw.length} jobs`);

    return raw.slice(0, maxResults).map((item) => this.mapNaukriItem(item)).filter((j) => this.matchesNaukri(j));
  }

  // Naukri already tailors recommendations to profile — skip requiredKeywords,
  // only apply exclude list and company blacklist
  private matchesNaukri(job: Job): boolean {
    const { excludeKeywords, blacklistCompanies } = this.cfg.search;
    const text = `${job.title} ${job.description ?? ""}`.toLowerCase();
    if (blacklistCompanies.some((c) => job.company.toLowerCase().includes(c.toLowerCase()))) return false;
    if (excludeKeywords.some((kw) => text.includes(kw.toLowerCase()))) return false;
    return true;
  }

  async applyToJob(job: Job): Promise<ApplicationResult> {
    if (await hasApplied(job.id)) return { job, status: "already_applied" };

    // Prefer direct API apply if we have a JWT token
    if (this.accessToken && job.naukriJobId) {
      return this.applyViaAPI(job);
    }
    // Fallback to Playwright
    return this.applyViaBrowser(job);
  }

  // ── Direct API apply (no browser needed) ─────────────────
  private async applyViaAPI(job: Job): Promise<ApplicationResult> {
    try {
      const sid = Date.now().toString();
      this.log(`API apply → jobId: ${job.naukriJobId} | ${job.title} @ ${job.company}`);

      const applyBody = {
        strJobsarr:       [job.naukriJobId!],
        logstr:           `--jobSearch-1-F-0-1--${sid}-`,
        flowtype:         "show",
        crossdomain:      true,
        jquery:           1,
        rdxMsgId:         "",
        chatBotSDK:       true,
        mandatory_skills: job.mandatorySkills ?? [],
        optional_skills:  job.optionalSkills  ?? [],
        applyTypeId:      "107",
        closebtn:         "y",
        applySrc:         "jobSearch",
        sid,
        mid:              "",
      };

      const applyRes = await axios.post<ApplyResponse>(APPLY_API, applyBody, {
        headers: this.applyHeaders(), timeout: 15000,
      });

      // Log the raw response so we can debug
      const rawData = applyRes.data;
      this.log(`API response [${applyRes.status}]: ${JSON.stringify(rawData).slice(0, 300)}`);

      const applyData = (rawData as Record<string, unknown>)?.["data"] ?? rawData as Record<string, unknown>;

      // Check for explicit error message in body
      const errMsg = (applyData as Record<string, unknown>)?.["message"] as string | undefined;
      if (errMsg && /already applied|error|failed|invalid/i.test(errMsg)) {
        if (/already applied/i.test(errMsg)) {
          return { job, status: "already_applied" };
        }
        return { job, status: "failed", error: `API rejected: ${errMsg}` };
      }

      // Check if chatbot screening is required
      const needsChatbot = !!(applyData as Record<string, unknown>)?.["isChatBot"];
      if (needsChatbot) {
        this.log(`Chatbot screening for: ${job.title}`);
        const chatbotOk = await this.handleChatbot(job.naukriJobId!);
        if (!chatbotOk) {
          return { job, status: "skipped", error: "Chatbot could not be completed" };
        }
      }

      this.log(`✓ Applied via API: ${job.title} @ ${job.company}`);
      await delay(2000, 4000);
      return { job, status: "applied", appliedAt: new Date().toISOString() };

    } catch (err) {
      if (axios.isAxiosError(err) && err.response) {
        const status = err.response.status;
        const body   = JSON.stringify(err.response.data).slice(0, 300);
        this.log(`API error HTTP ${status}: ${body}`);
        if (status === 401 || status === 403) {
          this.log("Token expired — falling back to browser apply");
          return this.applyViaBrowser(job);
        }
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`API apply threw: ${msg}`);
      // Fall back to browser instead of failing hard
      this.log("Falling back to browser apply");
      return this.applyViaBrowser(job);
    }
  }

  // ── Chatbot screening question handler ───────────────────
  private async handleChatbot(jobId: string): Promise<boolean> {
    const profile = loadProfile();
    const conv    = `${jobId}_apply`;

    // Map of question keywords → answers from profile
    const answerMap: Record<string, string> = {
      "notice period":   profile.noticePeriod    || "30 days",
      "current ctc":     profile.currentCTC      || "Not disclosed",
      "expected ctc":    profile.expectedCTC     || "Open to discussion",
      "current salary":  profile.currentCTC      || "Not disclosed",
      "expected salary": profile.expectedCTC     || "Open to discussion",
      "experience":      String(profile.yearsOfExperience || 5),
      "years":           String(profile.yearsOfExperience || 5),
      "location":        "Bengaluru",
      "relocate":        profile.willingToRelocate || "Yes",
      "willing to":      profile.willingToRelocate || "Yes",
      "work from home":  "Yes",
      "remote":          "Yes",
      "immediate":       profile.noticePeriod    || "30 days",
    };

    let status = "Fresh";
    let maxTurns = 10;

    while (maxTurns-- > 0) {
      const body = {
        input:        { text: [""], id: ["-1"] },
        appName:      conv,
        domain:       "Naukri",
        conversation: conv,
        channel:      "web",
        status,
        utmSource:    "",
        utmContent:   "",
        deviceType:   "WEB",
      };

      let chatRes: ChatbotResponse;
      try {
        const r = await axios.post<ChatbotResponse>(CHATBOT_API, body, {
          headers: this.chatbotHeaders(), timeout: 15000,
        });
        chatRes = r.data;
      } catch {
        break; // chatbot unavailable — treat as success (already applied)
      }

      // Check if complete
      if (chatRes.isComplete || chatRes.complete || chatRes.status === "complete") break;
      const msgs = chatRes.data?.messages ?? chatRes.messages ?? [];
      if (chatRes.data?.isComplete) break;

      // Find the question message
      const question = msgs.find((m) => m.type === "radio" || m.type === "checkbox" || m.type === "text" || m.type === "number")
        ?? msgs[msgs.length - 1];

      if (!question) break;

      const qText = (question.text ?? chatRes.msg ?? chatRes.message ?? "").toLowerCase();
      this.log(`Chatbot Q: ${qText.slice(0, 80)}`);

      let answerText = "";
      let answerId   = "-1";

      // If options provided, pick best matching one
      if (question.options && question.options.length > 0) {
        const matched = this.pickBestOption(question.options, qText, profile);
        answerText = matched.text;
        answerId   = matched.id;
      } else {
        // Free-text answer — find best match from answerMap
        for (const [keyword, answer] of Object.entries(answerMap)) {
          if (qText.includes(keyword)) { answerText = answer; break; }
        }
        if (!answerText) answerText = "5"; // safe numeric fallback
      }

      this.log(`Chatbot A: ${answerText}`);

      // Submit the answer
      const answerBody = {
        input:        { text: [answerText], id: [answerId] },
        appName:      conv,
        domain:       "Naukri",
        conversation: conv,
        channel:      "web",
        status:       "InProgress",
        utmSource:    "",
        utmContent:   "",
        deviceType:   "WEB",
      };

      try {
        const ar = await axios.post<ChatbotResponse>(CHATBOT_API, answerBody, {
          headers: this.chatbotHeaders(), timeout: 15000,
        });
        if (ar.data.isComplete || ar.data.complete || ar.data.data?.isComplete) {
          this.log("Chatbot screening complete ✓");
          return true;
        }
        status = "InProgress";
      } catch { break; }

      await delay(500, 1000);
    }

    return true; // even if chatbot fails, the initial apply may have gone through
  }

  private pickBestOption(
    options: Array<{ id: string; text: string; value?: string }>,
    question: string,
    profile: ReturnType<typeof loadProfile>
  ): { id: string; text: string } {
    const noticeLower = (profile.noticePeriod || "30").toLowerCase();
    const expStr = String(profile.yearsOfExperience || 5);

    // Notice period options
    if (question.includes("notice")) {
      const match = options.find((o) => o.text.toLowerCase().includes(noticeLower.replace(" days", "")));
      if (match) return match;
    }
    // Yes/No questions — prefer "Yes" for relocate, "No" for "immediate joiner"
    if (question.includes("relocate") || question.includes("remote") || question.includes("work from home")) {
      const yes = options.find((o) => o.text.toLowerCase() === "yes");
      if (yes) return yes;
    }
    if (question.includes("immediate")) {
      const no = options.find((o) => o.text.toLowerCase() === "no");
      if (no) return no;
    }
    // Experience range — find range that includes profile years
    if (question.includes("experience") || question.includes("years")) {
      const exp = parseInt(expStr, 10);
      const rangeOpt = options.find((o) => {
        const m = o.text.match(/(\d+)\s*[-–]\s*(\d+)/);
        if (m) return exp >= parseInt(m[1], 10) && exp <= parseInt(m[2], 10);
        const single = o.text.match(/^(\d+)\+?$/);
        if (single) return exp >= parseInt(single[1], 10);
        return false;
      });
      if (rangeOpt) return rangeOpt;
    }
    // Default: first option
    return options[0] ?? { id: "-1", text: "" };
  }

  // ── Browser apply (Playwright) ───────────────────────────
  private async applyViaBrowser(job: Job): Promise<ApplicationResult> {
    // If the user has recorded a flow, replay it first
    if (hasRecordedFlow()) {
      this.log(`Replaying recorded flow for: ${job.title} @ ${job.company}`);
      const result = await replayFlow(this.page, job.url, (msg) => this.log(msg));
      if (result === "applied")  return { job, status: "applied", appliedAt: new Date().toISOString() };
      if (result === "skipped")  return { job, status: "already_applied" };
      this.log("Replay failed — falling back to selector-based apply");
    }

    try {
      this.log(`Browser apply → ${job.url}`);
      await this.page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await delay(2500, 3500);
      this.pagesVisited++;

      const landedUrl = this.page.url();
      this.log(`Page loaded: ${landedUrl}`);

      if (this.isExternalATS()) {
        return { job, status: "skipped", error: `External ATS: ${landedUrl}` };
      }

      // Check "already applied" before doing anything
      const initialText = await this.page.$eval("body", (b) => b.innerText).catch(() => "");
      if (/already applied/i.test(initialText)) {
        return { job, status: "already_applied" };
      }

      // Skip external company-site apply buttons
      const externalApply = await this.page.$('a:has-text("Apply on company website"), button:has-text("Apply on Company Website"), a[class*="company-site"]');
      if (externalApply && await externalApply.isVisible().catch(() => false)) {
        return { job, status: "skipped", error: "Apply on company website only" };
      }

      // ── Find apply button ────────────────────────────────
      const applySelectors = [
        "#apply-button",
        'button[id="apply-button"]',
        'a[id="apply-button"]',
        'button[class*="apply-button"]:not([disabled])',
        'div.apply-button button',
        'div.apply-button a',
        'button:has-text("Apply"):visible',
        'a.btn:has-text("Apply"):visible',
      ];

      let applyBtn = null;
      let usedSel  = "";
      for (const sel of applySelectors) {
        try {
          const el = await this.page.$(sel);
          if (el && await el.isVisible()) { applyBtn = el; usedSel = sel; break; }
        } catch { /* selector might not be valid */ }
      }

      if (!applyBtn) {
        const visibleBtns = await this.page.$$eval(
          "button:not([hidden]), a[class*='btn']:not([hidden])",
          (els) => els.slice(0, 15).map((e) => `${e.tagName}#${(e as HTMLElement).id || ""} "${e.textContent?.trim().slice(0, 40)}"`)
        ).catch(() => []);
        this.log(`No apply button — visible buttons: ${visibleBtns.join(" | ")}`);
        return { job, status: "skipped", error: "No apply button found" };
      }

      this.log(`Clicking apply button (${usedSel})`);
      await applyBtn.click();

      // ── Wait for modal/chatbot to actually appear ────────
      const modalSels = [
        'div[class*="apply-popup"]',
        'div[class*="quickApply"]',
        'div[class*="applyModal"]',
        'div[class*="chatbot"]',
        'div[class*="modal"][class*="apply"]',
        'div[role="dialog"]',
        '.chatbot-container',
        'div[class*="overlay"][class*="apply"]',
      ];

      let modalFound = false;
      // Race: first modal to become visible wins, timeout after 8s
      await Promise.race([
        ...modalSels.map((sel) =>
          this.page.waitForSelector(sel, { state: "visible", timeout: 8000 }).then(() => {
            modalFound = true;
          }).catch(() => {})
        ),
        delay(8000, 8000),
      ]);

      if (modalFound) {
        this.log("Modal/chatbot opened — filling screening questions");
      } else {
        this.log("No modal detected — applying directly");
        await delay(1500, 2000);
      }

      // Fill any visible screening inputs
      await this.fillScreeningQuestions();
      await delay(1000, 1500);

      // ── Find and click the final Submit/Apply button ─────
      const submitSelectors = [
        'button[type="submit"]:visible',
        'button:has-text("Submit"):visible',
        'button:has-text("Apply"):not([id="apply-button"]):visible',
        'button:has-text("Confirm"):visible',
        'a:has-text("Apply now"):visible',
        'input[type="submit"]:visible',
      ];
      for (const sel of submitSelectors) {
        try {
          const btn = await this.page.$(sel);
          if (btn && await btn.isVisible()) {
            this.log(`Clicking submit: ${sel}`);
            await btn.click();
            await delay(2500, 3500);
            break;
          }
        } catch { /* skip */ }
      }

      if (this.isExternalATS()) {
        return { job, status: "skipped", error: "Redirected to external ATS after apply" };
      }

      // ── Detect success / already applied ─────────────────
      const afterText = await this.page.$eval("body", (b) => b.innerText).catch(() => "");
      if (/already applied/i.test(afterText)) {
        return { job, status: "already_applied" };
      }

      const afterUrl   = this.page.url();
      const didSucceed = /applied successfully|application submitted|you.ve applied/i.test(afterText);
      this.log(`After apply — URL: ${afterUrl} | success: ${didSucceed}`);
      this.log(`✓ Applied via browser: ${job.title} @ ${job.company}`);
      return { job, status: "applied", appliedAt: new Date().toISOString() };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`Browser apply error: ${msg}`);
      return { job, status: "failed", error: msg };
    }
  }

  // Expose performance stats (called from server)
  async fetchPerformanceStats(): Promise<Record<string, unknown>> {
    try {
      const res = await axios.get("https://www.naukri.com/cloudgateway-mynaukri/wrapperfacade/v1/mynaukri/performance", {
        headers: {
          "accept":          "application/json",
          "appid":           "105",
          "systemid":        "Naukri",
          "authorization":   `ACCESSTOKEN = ${this.accessToken}`,
          "cookie":          this.cookieHeader,
          "user-agent":      UA,
          "referer":         "https://www.naukri.com/mnjuser/performance",
        },
        timeout: 15000,
      });
      return res.data as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}
