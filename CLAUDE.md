# Job Application Web Crawler

A TypeScript/Node.js web crawler that automates job application workflows using Playwright for browser automation.

## Project Goal
Automate job applications by crawling job boards (LinkedIn, Indeed, Greenhouse, Lever, etc.), extracting job listings, and automating the application process.

## Stack
- **Runtime**: Node.js with TypeScript
- **Browser automation**: Playwright (handles JS-heavy pages, SPAs)
- **HTML parsing**: Cheerio (for static pages)
- **HTTP**: Axios (for API endpoints)
- **Config**: dotenv for credentials/secrets

## Project Structure
```
src/
  crawler/      # Core crawling logic (page navigation, link extraction)
  jobs/         # Job board-specific scrapers (LinkedIn, Indeed, etc.)
  utils/        # Shared helpers (delay, retry, logger)
  config/       # Configuration and constants
```

## How to Run
```bash
npm run dev       # Run with ts-node + nodemon (watch mode)
npm run build     # Compile TypeScript to dist/
npm start         # Run compiled output
npm run crawl     # Run the crawler once
```

## Key Conventions
- All browser automation goes through `src/crawler/` — never use Playwright directly in job scrapers
- Job board scrapers live in `src/jobs/` — one file per job board
- Credentials (email, password, API keys) go in `.env` — never hardcode
- Add random delays between actions (1–3s) to avoid rate limiting and bot detection
- Always close Playwright browser instances in finally blocks

## Common Patterns

### Adding a new job board scraper
1. Create `src/jobs/<board-name>.ts`
2. Export a class that extends `BaseScraper` from `src/crawler/base.ts`
3. Implement `fetchListings()` and `applyToJob()` methods

### Running with credentials
```bash
cp .env.example .env
# Fill in your credentials in .env
npm run crawl
```

## What NOT to Do
- Don't commit `.env` or any file with credentials
- Don't run without delays — job boards will block your IP
- Don't use `page.waitForTimeout()` — use the utility `delay()` from `src/utils/`
- Don't scrape at scale without checking the site's robots.txt and ToS
