import { BaseScraper } from "../crawler/base.js";
import type { Job, ApplicationResult, JobsConfig } from "../types/index.js";
import { delay } from "../utils/delay.js";
import { hasApplied } from "../tracker/storage.js";
import { loadProfile } from "../utils/profile.js";
import { cookiePath } from "../auth/loginManager.js";
import { upsertCareerPage } from "../tracker/careerPages.js";
import { chromium } from "playwright";
import axios from "axios";
import crypto from "crypto";
import fs from "fs";

const RECOM_API   = "https://www.naukri.com/jobapi/v2/search/recom-jobs";
const SEARCH_API  = "https://www.naukri.com/jobapi/v3/search";
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

  private searchHeaders(referer: string) {
    return {
      "accept":          "application/json",
      "appid":           "109",
      "clientid":        "d3skt0p",
      "systemid":        "Naukri",
      "gid":             "LOCATION,INDUSTRY,EDUCATION,FAREA_ROLE",
      "authorization":   `Bearer ${this.accessToken}`,
      "referer":         referer,
      "origin":          BASE_URL,
      "cookie":          this.cookieHeader,
      "user-agent":      UA,
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
    const profile = loadProfile();
    const experience = profile.yearsOfExperience || 5;

    const kwString = keywords.length > 0
      ? keywords.join(", ")
      : "node.js, node js developer, node, nestjs, typescript";

    const seoKey = "node-dot-js-node-js-developer-node-nestjs-typescript-jobs";
    const referer = `${BASE_URL}/${seoKey}?k=${encodeURIComponent(kwString)}&experience=${experience}`;
    const allRaw: NaukriJob[] = [];
    const PAGE_SIZE = 20;

    // Paginate until we have maxResults jobs or run out of pages
    for (let page = 1; allRaw.length < maxResults; page++) {
      const url = `${SEARCH_API}?noOfResults=${PAGE_SIZE}&urlType=search_by_keyword&searchType=adv` +
        `&keyword=${encodeURIComponent(kwString)}&pageNo=${page}&experience=${experience}` +
        `&k=${encodeURIComponent(kwString)}&src=jobsearchDesk`;

      this.log(`Fetching page ${page}… (${allRaw.length}/${maxResults} so far)`);
      try {
        const res = await axios.get<RecomResponse>(url, {
          headers: this.searchHeaders(referer), timeout: 15000,
        });
        const batch = res.data.jobDetails ?? [];
        this.log(`Page ${page}: ${batch.length} jobs`);
        allRaw.push(...batch);
        if (batch.length < PAGE_SIZE) break; // no more pages
        await delay(800, 1500);
      } catch (err) {
        this.log(`Search API failed on page ${page}, falling back to recommended jobs`);
        if (page === 1) return this.fetchRecommended(maxResults);
        break;
      }
    }

    this.log(`Search API total: ${allRaw.length} jobs across ${Math.ceil(allRaw.length / PAGE_SIZE)} pages`);

    const jobs = allRaw.slice(0, maxResults).map((item) => this.mapNaukriItem(item)).filter((j) => this.matchesNaukri(j));

    const withCareer = jobs.filter((j) => j.companyCareerUrl).length;
    if (withCareer > 0) this.log(`Career pages discovered: ${withCareer} companies`);

    return jobs;
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

      const applyBody = {
        strJobsarr:       [job.naukriJobId!],
        logstr:           `--drecomm_profile-1-F-0-1--${sid}-`,
        flowtype:         "show",
        crossdomain:      true,
        jquery:           1,
        rdxMsgId:         "",
        chatBotSDK:       true,
        mandatory_skills: job.mandatorySkills ?? [],
        optional_skills:  job.optionalSkills  ?? [],
        applyTypeId:      "107",
        closebtn:         "y",
        applySrc:         "drecomm_profile",
        sid,
        mid:              "",
      };

      const applyRes = await axios.post<ApplyResponse>(APPLY_API, applyBody, {
        headers: this.applyHeaders(), timeout: 15000,
      });

      const applyData = applyRes.data?.data ?? applyRes.data;

      // Check if chatbot screening is required
      const needsChatbot = (applyData as Record<string, unknown>)?.["isChatBot"] ?? false;

      if (needsChatbot) {
        this.log(`Chatbot screening triggered for: ${job.title}`);
        const chatbotOk = await this.handleChatbot(job.naukriJobId!);
        if (!chatbotOk) {
          return { job, status: "skipped", error: "Chatbot screening could not be completed" };
        }
      }

      this.log(`✓ Applied via API: ${job.title} @ ${job.company}`);
      // Pace requests to avoid Naukri rate-limiting
      await delay(2000, 4000);
      return { job, status: "applied", appliedAt: new Date().toISOString() };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // If 401/403, token expired — fall back to browser
      if (axios.isAxiosError(err) && (err.response?.status === 401 || err.response?.status === 403)) {
        this.log("Token expired, falling back to browser apply");
        return this.applyViaBrowser(job);
      }
      // Log the actual HTTP status for debugging
      if (axios.isAxiosError(err) && err.response) {
        this.log(`API error ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 200)}`);
      }
      return { job, status: "failed", error: `API apply failed: ${msg}` };
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

  // ── Browser fallback (original Playwright approach) ───────
  private async applyViaBrowser(job: Job): Promise<ApplicationResult> {
    try {
      await this.page.goto(job.url, { waitUntil: "load", timeout: 30000 });
      await delay(1500, 2500);

      const externalBtn = await this.page.$('a[class*="company-site"], button:has-text("Apply on Company Website")');
      if (externalBtn) return { job, status: "skipped", error: "External company website apply" };

      const applyBtn = await this.page.$(
        '#apply-button, [id*="apply-button"], button[class*="applyBtn"]:not([class*="external"]), div[class*="apply-button"] button'
      );
      if (!applyBtn) return { job, status: "skipped", error: "No easy-apply button found" };

      await applyBtn.click();
      await delay(2000, 3000);
      await this.fillScreeningQuestions();
      await delay(500, 1000);

      const confirmBtn = await this.page.$('button[class*="applyBtn"], button:has-text("Apply"), button:has-text("Submit")');
      if (confirmBtn) { await confirmBtn.click(); await delay(1500, 2500); }

      if (this.isExternalATS()) return { job, status: "skipped", error: "Redirected to external ATS" };

      this.log(`✓ Applied via browser: ${job.title} @ ${job.company}`);
      return { job, status: "applied", appliedAt: new Date().toISOString() };
    } catch (err) {
      return { job, status: "failed", error: err instanceof Error ? err.message : String(err) };
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
