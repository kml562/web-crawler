import dotenv from "dotenv";
dotenv.config();

export const config = {
  headless: process.env["HEADLESS"] !== "false",
  maxApplications: Number(process.env["MAX_APPLICATIONS"] ?? 10),
  delay: {
    min: Number(process.env["DELAY_MIN_MS"] ?? 1000),
    max: Number(process.env["DELAY_MAX_MS"] ?? 3000),
  },
  linkedin: {
    email: process.env["LINKEDIN_EMAIL"] ?? "",
    password: process.env["LINKEDIN_PASSWORD"] ?? "",
  },
};
