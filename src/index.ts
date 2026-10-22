import { config } from "./config/index.js";

async function main() {
  console.log("Job Application Crawler starting...");
  console.log(`Max applications: ${config.maxApplications}`);
  console.log(`Headless mode: ${config.headless}`);
  // TODO: initialize job scrapers here
}

main().catch(console.error);
