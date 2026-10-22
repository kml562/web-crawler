import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import type { JobsConfig } from "../types/index.js";

dotenv.config();

export const config = {
  headless: process.env["HEADLESS"] !== "false",
  delay: {
    min: Number(process.env["DELAY_MIN_MS"] ?? 1000),
    max: Number(process.env["DELAY_MAX_MS"] ?? 3000),
  },
};

export function loadJobsConfig(): JobsConfig {
  const configPath = path.resolve("jobs.config.json");
  if (!fs.existsSync(configPath)) {
    throw new Error("jobs.config.json not found. Copy jobs.config.json and fill in your details.");
  }
  return JSON.parse(fs.readFileSync(configPath, "utf-8")) as JobsConfig;
}
