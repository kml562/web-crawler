# Web Crawler — Job Application Automator

A TypeScript/Node.js bot that crawls job boards (LinkedIn, Indeed, Greenhouse, Lever, etc.), extracts listings, and automates the application process using Playwright for browser automation.

---

## Features

- Crawls JavaScript-heavy job board pages via Playwright
- Parses static HTML listings with Cheerio
- Hits API endpoints directly with Axios where available
- Configurable credentials and targets via `.env`
- Random delays between actions to avoid rate limiting and bot detection

---

## Tech Stack

| Layer | Tool |
|---|---|
| Runtime | Node.js + TypeScript |
| Browser automation | Playwright |
| HTML parsing | Cheerio |
| HTTP | Axios |
| Config | dotenv |

---

## Project Structure

```
src/
  crawler/      # Core crawling logic (page navigation, link extraction)
  jobs/         # Job board-specific scrapers — one file per board
  utils/        # Shared helpers (delay, retry, logger)
  config/       # Configuration and constants
```

---

## Getting Started

### 1. Install dependencies

```bash
npm install
npx playwright install chromium
```

### 2. Configure credentials

```bash
cp .env.example .env
# Fill in your credentials in .env
```

### 3. Run

```bash
npm run dev      # Watch mode (ts-node + nodemon)
npm run crawl    # Single run
npm run build    # Compile to dist/
npm start        # Run compiled output
```

---

## Adding a New Job Board

1. Create `src/jobs/<board-name>.ts`
2. Export a class extending `BaseScraper` from `src/crawler/base.ts`
3. Implement `fetchListings()` and `applyToJob()` methods

```ts
import { BaseScraper } from '../crawler/base';

export class GreenhouseScraper extends BaseScraper {
  async fetchListings() { ... }
  async applyToJob(jobId: string) { ... }
}
```

---

## Rules

- Credentials live in `.env` — never hardcode them, never commit `.env`
- Always close Playwright browser instances in `finally` blocks
- Use `delay()` from `src/utils/` instead of `page.waitForTimeout()`
- Check `robots.txt` and ToS before scraping any site at scale

---

## License

ISC
