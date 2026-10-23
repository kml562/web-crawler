import { BaseScraper } from "../crawler/base.js";
import type { Job, ApplicationResult, JobsConfig } from "../types/index.js";
import { delay } from "../utils/delay.js";
import { hasApplied } from "../tracker/storage.js";
import { loadProfile } from "../utils/profile.js";
import { cookiePath, loginNaukriWithCredentials } from "../auth/loginManager.js";
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

    // Auto-login with email/password from .env if no saved session exists
    if (!this.cookieHeader) {
      const email    = process.env.NAUKRI_EMAIL    ?? "";
      const password = process.env.NAUKRI_PASSWORD ?? "";
      if (email && password) {
        this.log("No saved session — auto-logging in with NAUKRI_EMAIL / NAUKRI_PASSWORD from .env");
        await loginNaukriWithCredentials(email, password, (msg) => this.log(msg));
        this.loadSession(); // reload cookies saved by auto-login
      }
    }

    if (!this.cookieHeader) {
      throw new Error(
        "Naukri session not found. Either set NAUKRI_EMAIL and NAUKRI_PASSWORD in .env, " +
        "or connect manually from the Profile tab → Accounts."
      );
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
    const RECOM_PAGE = "https://www.naukri.com/mnjuser/recommendedjobs";
    this.log(`Loading recommended jobs page…`);

    // Intercept API for job count display only — don't map into individual jobs
    let jobCount = 0;
    const apiCapture = new Promise<void>((resolve) => {
      const handler = async (response: import("playwright").Response) => {
        const u = response.url();
        if (!u.includes("/recom-jobs") && !u.includes("/jobapi/v2/search") && !u.includes("/jobapi/v3/search")) return;
        try { const json = await response.json() as RecomResponse; jobCount = (json.jobDetails ?? []).length; } catch { /* ignore */ }
        this.page.off("response", handler);
        resolve();
      };
      this.page.on("response", handler);
    });

    await this.page.goto(RECOM_PAGE, { waitUntil: "domcontentloaded", timeout: 30000 });
    await delay(2000, 3000);
    await Promise.race([apiCapture, new Promise<void>((r) => setTimeout(r, 8000))]);

    if (jobCount > 0) this.log(`${jobCount} recommended jobs available`);

    // Always return a single placeholder — applyViaRecommendedPage does the real work.
    // ID includes today's date so the "already applied" check doesn't block future runs.
    const todayId = `naukri-recom-${new Date().toISOString().slice(0, 10)}`;
    return [{ id: todayId, title: "Recommended Jobs Batch", company: "Naukri",
      url: RECOM_PAGE, location: "", source: "naukri" as const, easyApply: true, foundAt: new Date().toISOString() }];
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
    // Placeholder is not a real job — always run the batch flow regardless of history
    if (!job.id.startsWith("naukri-recom-") && await hasApplied(job.id)) {
      return { job, status: "already_applied" };
    }
    return this.applyViaRecommendedPage(job);
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

  // ── Recommended-page apply — mirrors Python Naukri-Recommended.py exactly ──
  // Goes to /mnjuser/recommendedjobs, selects up to 5 job checkboxes,
  // clicks the multi-apply button, then handles the chatbot drawer.
  // Mirrors Python Recommended bot exactly:
  // Loop → select 5 unchecked → click multi-apply → handle chatbot → repeat until none left
  private async applyViaRecommendedPage(job: Job): Promise<ApplicationResult> {
    const RECOM_PAGE = "https://www.naukri.com/mnjuser/recommendedjobs";
    const MAX_BATCH  = this.cfg.maxApplicationsPerRun ?? 30;

    try {
      if (!this.page.url().includes("/recommendedjobs")) {
        await this.page.goto(RECOM_PAGE, { waitUntil: "domcontentloaded", timeout: 30000 });
        await delay(2000, 3000);
      } else {
        await delay(500, 800);
      }

      // Wait for job cards
      await this.page.waitForSelector(
        "article.jobTuple, div.srp-jobtuple-wrapper, div.cust-job-tuple",
        { timeout: 10000 }
      ).catch(() => {});

      const pageText = await this.page.$eval("body", (b) => b.innerText).catch(() => "");
      if (/daily quota has been expired/i.test(pageText)) {
        this.log("Daily quota expired — stopping");
        return { job, status: "skipped", error: "Daily quota expired" };
      }

      let totalApplied = 0;

      // ── Main loop — mirrors Python: while True: select 5 → apply → chatbot ─
      while (totalApplied < MAX_BATCH) {
        const jobCards = await this.page.$$("article.jobTuple, div.srp-jobtuple-wrapper");
        if (jobCards.length === 0) { this.log("No more job cards on page"); break; }

        let selected = 0;
        const titles: string[] = [];

        for (const card of jobCards) {
          if (selected >= 5) break;
          try {
            const alreadyChecked = await card.$(".naukicon-ot-Checked, .naukicon-ot-checkbox-selected, input[type='checkbox']:checked");
            if (alreadyChecked) continue;

            const cb = await card.$(".tuple-check-box, .tuple-check-box i, input[type='checkbox']");
            if (!cb) continue;

            const title   = await card.$eval("a.title, .title",       (el) => el.textContent?.trim() ?? "").catch(() => "");
            const company = await card.$eval("a.subTitle, .subTitle", (el) => el.textContent?.trim() ?? "").catch(() => "");

            await this.page.evaluate((el) => (el as HTMLElement).scrollIntoView({ block: "center" }), card);
            await delay(300, 500);
            await this.page.evaluate((el) => (el as HTMLElement).click(), cb);
            selected++;
            titles.push(`${title} @ ${company}`);
            this.log(`  ✓ Selected [${selected}/5]: ${title} @ ${company}`);
            await delay(600, 900);
          } catch { /* skip card */ }
        }

        if (selected === 0) { this.log("No more unchecked jobs — done"); break; }

        // Click multi-apply
        this.log(`Clicking multi-apply for ${selected} jobs…`);
        const applyBtn = await this.page.waitForSelector("button.multi-apply-button", {
          state: "visible", timeout: 5000,
        }).catch(() => null);

        if (applyBtn) {
          await this.page.evaluate((el) => (el as HTMLElement).click(), applyBtn);
        } else {
          // Fallback selectors
          for (const sel of ['button:has-text("Apply")', '[class*="multi-apply"] button']) {
            const fb = await this.page.waitForSelector(sel, { state: "visible", timeout: 2000 }).catch(() => null);
            if (fb) { await this.page.evaluate((el) => (el as HTMLElement).click(), fb); break; }
          }
        }

        await delay(3000, 4000);

        // Handle chatbot if it appears
        const chatbotOpen = await this.page.waitForSelector(
          "[id*='ChatbotContainer'], .chatbot_Drawer",
          { state: "visible", timeout: 10000 }
        ).then(() => true).catch(() => false);

        if (chatbotOpen) {
          this.log("Chatbot opened — answering screening questions");
          await this.handleChatbotDrawer();
        }

        totalApplied += selected;
        this.log(`✓ Batch done — ${totalApplied} total applied so far`);

        // Navigate back to recommended page to get fresh unchecked jobs for next batch
        // Python bot loops back to the same page after each multi-apply
        await delay(2000, 3000);
        await this.page.goto(RECOM_PAGE, { waitUntil: "domcontentloaded", timeout: 30000 });
        await delay(2000, 3000);
        await this.page.waitForSelector(
          "article.jobTuple, div.srp-jobtuple-wrapper, div.cust-job-tuple",
          { timeout: 10000 }
        ).catch(() => {});

        // Check daily quota after each batch
        const afterText = await this.page.$eval("body", (b) => b.innerText).catch(() => "");
        if (/daily quota has been expired/i.test(afterText)) {
          this.log("Daily quota expired after batch — stopping");
          break;
        }
      }

      if (totalApplied === 0) return { job, status: "skipped", error: "No jobs could be selected" };
      return { job, status: "applied", appliedAt: new Date().toISOString() };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`Recommended-page apply error: ${msg}`);
      return { job, status: "failed", error: msg };
    }
  }

  // ── Browser apply — mirrors Python bot (Naukri-Edge.py) exactly ────────────
  private async applyViaBrowser(job: Job): Promise<ApplicationResult> {
    if (hasRecordedFlow()) {
      this.log(`Replaying recorded flow for: ${job.title} @ ${job.company}`);
      const result = await replayFlow(this.page, job.url, (msg) => this.log(msg));
      if (result === "applied") return { job, status: "applied", appliedAt: new Date().toISOString() };
      if (result === "skipped") return { job, status: "already_applied" };
      this.log("Replay failed — falling back to selector-based apply");
    }

    try {
      this.log(`Browser apply → ${job.url}`);

      // domcontentloaded + explicit delay — matches Python bot's "driver.get(link); time.sleep(4)"
      // networkidle can hang forever on Naukri's React SPA and timeout everything
      await this.page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await delay(3000, 4000);
      this.pagesVisited++;

      // Quick checks before touching any button
      const bodyText = await this.page.$eval("body", (b) => b.innerText).catch(() => "");
      if (/already applied/i.test(bodyText))          return { job, status: "already_applied" };
      if (/daily quota has been expired/i.test(bodyText)) {
        this.log("Daily quota expired — stopping");
        return { job, status: "skipped", error: "Daily quota expired" };
      }

      // ── Find apply button — Python bot: ID first, then text variants ──────
      // Naukri 2026: id="company-site-button" / text="Apply on company site"
      const applySelectors = [
        "#company-site-button",
        'button:has-text("Apply on company site")',
        'button:has-text("Apply on Company Site")',
        "#apply-button",
        'button:has-text("Apply Now")',
        'button:has-text("Easy Apply")',
        'button:has-text("Apply")',
        '[class*="apply-button-container"] button',
      ];

      let applyBtn = null;
      let usedSel  = "";
      for (const sel of applySelectors) {
        try {
          const el = await this.page.waitForSelector(sel, { state: "visible", timeout: 3000 });
          if (el) { applyBtn = el; usedSel = sel; break; }
        } catch { /* not found — try next */ }
      }

      if (!applyBtn) {
        const visible = await this.page.$$eval(
          "button, [role='button']",
          (els) => els.filter((e) => (e as HTMLElement).offsetParent !== null)
                       .slice(0, 15)
                       .map((e) => `"${e.textContent?.trim().slice(0, 40)}"`)
        ).catch(() => [] as string[]);
        this.log(`No apply button. URL: ${this.page.url()} | buttons: ${visible.join(", ")}`);
        return { job, status: "skipped", error: "No apply button found" };
      }

      // JS click — Python bot: driver.execute_script("arguments[0].click()", btn)
      this.log(`Clicking apply (${usedSel})`);
      await this.page.evaluate((el) => (el as HTMLElement).click(), applyBtn);
      await delay(2000, 3000); // Python bot: time.sleep(2)

      // Post-click checks
      const postText = await this.page.$eval("body", (b) => b.innerText).catch(() => "");
      if (/daily quota has been expired/i.test(postText)) {
        return { job, status: "skipped", error: "Daily quota expired" };
      }
      if (/already applied/i.test(postText)) return { job, status: "already_applied" };

      // ── Fill name fields if inline form appeared ──────────────────────────
      const profile = loadProfile();
      try {
        const fn = await this.page.waitForSelector("#CUSTOM-FIRSTNAME", { state: "visible", timeout: 2000 });
        await fn.fill(profile.firstName || "");
        this.log(`Filled first name`);
      } catch { /* field not present */ }
      try {
        const ln = await this.page.waitForSelector("#CUSTOM-LASTNAME", { state: "visible", timeout: 1000 });
        await ln.fill(profile.lastName || "");
      } catch { /* field not present */ }

      // ── Chatbot drawer — Python bot: WebDriverWait(driver, 10) ───────────
      const chatbotOpen = await this.page.waitForSelector(
        "[id*='ChatbotContainer'], .chatbot_Drawer",
        { state: "visible", timeout: 10000 }
      ).then(() => true).catch(() => false);

      if (chatbotOpen) {
        this.log("Chatbot drawer opened — handling screening");
        await this.handleChatbotDrawer();
      }

      // ── Try submit button if a review screen appeared ─────────────────────
      for (const sel of [
        'button:has-text("Submit and Apply")',
        'button:has-text("Submit")',
        'button[type="submit"]',
      ]) {
        try {
          const btn = await this.page.waitForSelector(sel, { state: "visible", timeout: 2000 });
          if (btn) {
            this.log(`Clicking submit: ${sel}`);
            await this.page.evaluate((el) => (el as HTMLElement).click(), btn);
            await delay(2000, 3000);
            break;
          }
        } catch { /* not present */ }
      }

      // Python bot: counts as applied as soon as button was clicked successfully
      this.log(`✓ Applied via browser: ${job.title} @ ${job.company}`);
      return { job, status: "applied", appliedAt: new Date().toISOString() };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`Browser apply error: ${msg}`);
      return { job, status: "failed", error: msg };
    }
  }

  // ── Answer knowledge base (mirrors Python bot's application_answers.csv) ──
  private static readonly ANSWERS_PATH = "data/naukri_chatbot_answers.json";

  private loadChatbotAnswers(): Record<string, string> {
    try {
      if (fs.existsSync(NaukriScraper.ANSWERS_PATH))
        return JSON.parse(fs.readFileSync(NaukriScraper.ANSWERS_PATH, "utf-8")) as Record<string, string>;
    } catch { /* ignore */ }
    return {};
  }

  private saveChatbotAnswer(question: string, answer: string, answers: Record<string, string>): void {
    if (!question || !answer) return;
    answers[question.trim()] = answer.trim();
    try {
      fs.mkdirSync("data", { recursive: true });
      fs.writeFileSync(NaukriScraper.ANSWERS_PATH, JSON.stringify(answers, null, 2));
      this.log(`💾 Saved answer: "${question.slice(0, 50)}" → "${answer}"`);
    } catch { /* ignore */ }
  }

  // Word-overlap fuzzy match — mirrors Python's difflib.get_close_matches(cutoff=0.72)
  private fuzzyLookup(question: string, answers: Record<string, string>): string | null {
    const q = question.toLowerCase().trim();
    if (answers[q]) return answers[q];
    const qWords = q.split(/\s+/).filter((w) => w.length > 3);
    let best = 0; let bestAns: string | null = null;
    for (const [key, val] of Object.entries(answers)) {
      const kWords = key.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
      const overlap = qWords.filter((w) => kWords.includes(w)).length;
      const score = overlap / Math.max(qWords.length, kWords.length, 1);
      if (score >= 0.65 && score > best) { best = score; bestAns = val; }
    }
    if (bestAns) this.log(`~ Fuzzy match (${(best * 100).toFixed(0)}%): "${bestAns}"`);
    return bestAns;
  }

  private async getLatestBotQuestion(): Promise<string> {
    return this.page.$$eval(
      ".chatbot_ListItem.botItem .msg, .botMsg .msg",
      (els) => els[els.length - 1]?.textContent?.trim() ?? ""
    ).catch(() => "");
  }

  private async getLatestUserAnswer(): Promise<string> {
    return this.page.$$eval(
      ".chatbot_ListItem.userItem .msg, .userMsg .msg",
      (els) => els[els.length - 1]?.textContent?.trim() ?? ""
    ).catch(() => "");
  }

  private async getUserMessageCount(): Promise<number> {
    return this.page.$$eval(
      ".chatbot_ListItem.userItem .msg, .userMsg .msg",
      (els) => els.length
    ).catch(() => 0);
  }

  // ── Chatbot drawer handler — self-learning, mirrors Python Recommended bot ──
  // Known answer → auto-fill. Unknown → wait for user to answer in browser → save.
  private async handleChatbotDrawer(): Promise<void> {
    const profile  = loadProfile();
    const answers  = this.loadChatbotAnswers();

    const CHATBOT_SEL =
      "[id*='ChatbotContainer'], .chatbot_Drawer, [class*='chatbot'], " +
      "[class*='Chatbot'], .apply-modal, .chatbotModal, [id*='chatbot']";

    for (let i = 0; i < 60; i++) { // up to 2 min (60 × ~2s)
      await delay(1500, 2000);

      const drawerOpen = await this.page.waitForSelector(
        CHATBOT_SEL,
        { state: "visible", timeout: 1000 }
      ).then(() => true).catch(() => false);
      if (!drawerOpen) { this.log("Chatbot drawer closed ✓"); return; }

      // On first iteration — dump chatbot HTML for debugging selector mismatches
      if (i === 0) {
        const dbgHtml = await this.page.$eval(
          CHATBOT_SEL,
          (el) => el.innerHTML.replace(/\s+/g, " ").slice(0, 600)
        ).catch(() => "(could not read chatbot HTML)");
        this.log(`[chatbot-debug] innerHTML: ${dbgHtml}`);
      }

      let handled = false;

      // ── Radio buttons ──────────────────────────────────────────────────────
      try {
        const radioContainer = await this.page.waitForSelector(
          ".singleselect-radiobutton-container, [class*='radio-container'], [class*='radioContainer']," +
          "[class*='ssrc__container'], .chatbot_radio_container",
          { state: "visible", timeout: 2000 }
        );

        const question = await this.getLatestBotQuestion();
        const radios   = await radioContainer.$$(".ssrc__radio, input[type='radio'], [class*='radio__input']");
        const labels   = await radioContainer.$$(".ssrc__label, label, [class*='radio__label']");
        const opts     = await Promise.all(labels.map((l) => l.textContent().then((t) => t?.trim() ?? "")));

        this.log(`📋 Radio Q: "${question.slice(0, 80)}" Options: [${opts.join(", ")}]`);

        // 1. Known answer from saved answers (fuzzy match)
        const known = this.fuzzyLookup(question, answers);
        if (known) {
          let clicked = false;
          for (let j = 0; j < radios.length; j++) {
            const opt = (opts[j] ?? "").toLowerCase();
            if (opt === known.toLowerCase() || opt.startsWith(known.toLowerCase().slice(0, 5))) {
              await this.page.evaluate((el) => (el as HTMLElement).click(), radios[j]);
              this.log(`✓ Auto-filled (saved): "${known}"`);
              await delay(500, 800); await this.clickChatSend();
              clicked = true; handled = true; break;
            }
          }
          if (clicked) continue;
        }

        // 2. Profile-based heuristic (experience range, relocate, notice period)
        const q = question.toLowerCase();
        let pick = -1;
        if (q.includes("relocate") || q.includes("work from home") || q.includes("remote")) {
          pick = opts.findIndex((o) => /yes/i.test(o));
          if (pick < 0) pick = 0;
        } else if (q.includes("immediate")) {
          pick = opts.findIndex((o) => /no/i.test(o));
          if (pick < 0) pick = radios.length > 1 ? 1 : 0;
        } else if (q.includes("notice")) {
          const np = (profile.noticePeriod || "30").toLowerCase();
          pick = opts.findIndex((o) => o.toLowerCase().includes(np.replace(" days", "")));
          if (pick < 0) pick = 0;
        } else if (q.includes("experience") || q.includes("years")) {
          const exp = profile.yearsOfExperience || 5;
          pick = opts.findIndex((o) => { const m = o.match(/(\d+)\s*[-–]\s*(\d+)/); return m ? exp >= +m[1] && exp <= +m[2] : false; });
          if (pick < 0) pick = 0;
        }

        if (pick >= 0 && radios[pick]) {
          await this.page.evaluate((el) => (el as HTMLElement).click(), radios[pick]);
          this.log(`✓ Auto-filled (heuristic): "${opts[pick]}"`);
          this.saveChatbotAnswer(question, opts[pick] ?? "", answers);
          await delay(500, 800); await this.clickChatSend();
          handled = true; continue;
        }

        // 3. Unknown — wait for user to click in browser, then save their choice
        this.log(`❓ Unknown radio — click your answer in the browser (waiting up to 60s)…`);
        const prevCount = await this.getUserMessageCount();
        const userAnswered = await this.waitForUserInput(radioContainer, prevCount, 60);
        if (userAnswered) {
          // Detect which radio is now selected
          const freshRadios = await radioContainer.$$(".ssrc__radio");
          const freshLabels = await radioContainer.$$(".ssrc__label");
          for (let j = 0; j < freshRadios.length; j++) {
            const checked = await freshRadios[j].evaluate((el) => (el as HTMLInputElement).checked).catch(() => false);
            if (checked) {
              const chosen = await freshLabels[j]?.textContent().then((t) => t?.trim() ?? "").catch(() => "");
              this.saveChatbotAnswer(question, chosen, answers);
              this.log(`✓ User chose: "${chosen}" — saved for next time`);
              break;
            }
          }
          handled = true;
        }
      } catch { /* no radio this iteration */ }

      if (handled) continue;

      // ── Free-text / contenteditable ────────────────────────────────────────
      try {
        const textArea = await this.page.waitForSelector(
          ".chatbot_SendMessageContainer .textArea[contenteditable='true']," +
          ".chatbot_InputContainer .textArea[contenteditable='true']," +
          "div.textArea[contenteditable='true']," +
          "[class*='chatbot'] [contenteditable='true']," +
          "[class*='Chatbot'] textarea," +
          "[class*='chatbot'] textarea",
          { state: "visible", timeout: 2000 }
        );

        const question = await this.getLatestBotQuestion();
        this.log(`📝 Text Q: "${question.slice(0, 60)}"`);

        // Known answer → auto-fill; fallback to profile heuristic
        const answer = this.fuzzyLookup(question, answers) ?? this.pickChatbotTextAnswer(question, profile);
        const isNew  = !this.fuzzyLookup(question, answers);

        if (answer) {
          await textArea.evaluate((el: HTMLElement, v: string) => {
            el.focus(); el.innerText = v;
            el.dispatchEvent(new Event("input",  { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }, answer);
          this.log(`✓ Auto-filled: "${answer}"`);
          await delay(300, 500); await this.clickChatSend();
          if (isNew) this.saveChatbotAnswer(question, answer, answers);
        } else {
          // Completely unknown — wait for user to type and send
          this.log(`❓ Unknown text question — type your answer in the browser (waiting up to 60s)…`);
          const prevCount = await this.getUserMessageCount();
          const userAnswered = await this.waitForUserInput(null, prevCount, 60);
          if (userAnswered) {
            const typed = await this.getLatestUserAnswer();
            if (typed) this.saveChatbotAnswer(question, typed, answers);
            this.log(`✓ User typed: "${typed}" — saved for next time`);
          }
        }
        handled = true;
      } catch { /* no text area */ }
    }
  }

  // Polls up to maxSeconds waiting for user to answer in the browser
  private async waitForUserInput(
    radioContainer: import("playwright").ElementHandle | null,
    prevMsgCount: number,
    maxSeconds: number
  ): Promise<boolean> {
    const iters = Math.ceil(maxSeconds / 2);
    for (let i = 0; i < iters; i++) {
      await delay(2000, 2000);

      // User sent a chat message
      const newCount = await this.getUserMessageCount();
      if (newCount > prevMsgCount) return true;

      if (radioContainer) {
        // Radio container disappeared (next question loaded)
        const gone = !(await radioContainer.isVisible().catch(() => false));
        if (gone) return true;
        // A radio got checked
        const radios = await radioContainer.$$(".ssrc__radio").catch(() => []);
        for (const rb of radios) {
          const checked = await rb.evaluate((el) => (el as HTMLInputElement).checked).catch(() => false);
          if (checked) return true;
        }
      }
    }
    return false;
  }

  private async clickChatSend(): Promise<void> {
    for (const sel of [
      ".sendMsg", "[class*='sendMsg']", "div.sendMsg",
      "button[class*='send']", "[class*='Send'][role='button']",
      "button.chatbot_send", "[class*='chatbot'] button[type='submit']",
    ]) {
      try {
        const el = await this.page.waitForSelector(sel, { state: "visible", timeout: 2000 });
        if (el) {
          await this.page.evaluate((e) => (e as HTMLElement).click(), el);
          await delay(1500, 2000);
          return;
        }
      } catch { /* try next */ }
    }
  }

  private pickChatbotTextAnswer(question: string, profile: ReturnType<typeof loadProfile>): string {
    const q = question.toLowerCase();
    if (q.includes("notice")) return profile.noticePeriod || "30 days";
    if (q.includes("current ctc") || q.includes("current salary")) return profile.currentCTC || "Not disclosed";
    if (q.includes("expected ctc") || q.includes("expected salary")) return profile.expectedCTC || "Open to discussion";
    if (q.includes("experience") || q.includes("years")) return String(profile.yearsOfExperience || 5);
    if (q.includes("location")) return profile.preferredLocations[0] || "Bengaluru";
    if (q.includes("reason") || q.includes("why")) return "Looking for new challenges and growth opportunities";
    return "";
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
