# Job Application Web Crawler

A TypeScript/Node.js web crawler that automates job applications across LinkedIn, Indeed, Greenhouse, Lever, Naukri, Wellfound, and WeWorkRemotely using Playwright.

## Project Goal
Automate the job search and application process for Software Engineer / SDE roles. Configured for Kamal Bisht's job hunt.

## Stack
- **Runtime**: Node.js + TypeScript
- **Browser automation**: Playwright (handles JS-heavy SPAs)
- **HTML parsing**: Cheerio
- **HTTP (API-based boards)**: Axios
- **Config**: dotenv + jobs.config.json

## Project Structure
```
src/
  types/index.ts        # Shared types: Job, ApplicationResult, JobsConfig
  config/index.ts       # Config loader (env + jobs.config.json)
  crawler/
    browser.ts          # Playwright browser singleton
    base.ts             # BaseScraper abstract class
  jobs/
    linkedin.ts         # LinkedIn Easy Apply
    indeed.ts           # Indeed scraper
    greenhouse.ts       # Greenhouse JSON API + auto-fill
    lever.ts            # Lever JSON API + auto-fill
    naukri.ts           # Naukri login + apply
    wellfound.ts        # Wellfound (AngelList) scraper
    weworkremotely.ts   # WeWorkRemotely scraper
  tracker/
    storage.ts          # JSON file read/write (data/applied.json)
  utils/
    delay.ts            # Random delay between actions
    logger.ts           # Colored console logger
    retry.ts            # Exponential backoff retry
  index.ts              # Main orchestrator

jobs.config.json        # Search criteria, resume info, source toggles
data/applied.json       # Applied job log (auto-created)
.env                    # Credentials (never commit)
```

## How to Run
```bash
# First time setup
cp .env.example .env            # Fill in credentials
# Add your resume.pdf to the project root

# Run in list mode (finds jobs, no auto-apply)
npm run crawl

# Enable auto-apply: set "autoApply": true in jobs.config.json
npm run crawl

# Dev mode (watch)
npm run dev
```

## Key Conventions
- All Playwright browser sessions go through `src/crawler/browser.ts` — use `newPage()`, never `chromium.launch()` directly
- One file per job board in `src/jobs/` — each extends `BaseScraper`
- Credentials always from `.env`, never hardcoded
- Use `delay()` from `src/utils/delay.ts` between actions — never `page.waitForTimeout()`
- Always call `scraper.close()` in a finally block
- `hasApplied(jobId)` before every application to prevent duplicates

## Adding a New Job Board
1. Create `src/jobs/<board>.ts` extending `BaseScraper`
2. Implement `fetchListings()` and `applyToJob()`
3. Add a `boolean` toggle to `JobsConfig.sources` in `src/types/index.ts`
4. Wire it up in `src/index.ts`
5. Add credentials to `.env.example` if needed

## jobs.config.json Fields
- `search.autoApply`: set `true` to actually submit applications
- `search.excludeKeywords`: e.g. `["senior", "staff"]` to skip senior roles
- `search.blacklistCompanies`: companies to skip entirely
- `maxApplicationsPerRun`: safety cap per run
- `sources.*`: enable/disable each job board

## What NOT to Do
- Don't commit `.env` — it has real passwords
- Don't remove the random delays — job boards will block your IP
- Don't set `maxApplicationsPerRun` above 30 in a single run
- Don't use `page.waitForTimeout()` — use `delay()` instead
