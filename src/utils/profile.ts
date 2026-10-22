import fs from "fs";
import path from "path";
import { connectDB } from "../db/connect.js";
import { Profile } from "../db/models/Profile.js";

const PROFILE_FILE = path.resolve("data/profile.json");
const RESUME_PATH  = path.resolve("data/resume.pdf");

export interface UserProfile {
  firstName:         string;
  lastName:          string;
  email:             string;
  phone:             string;
  linkedinUrl:       string;
  portfolioUrl:      string;
  githubUrl:         string;
  currentRole:       string;
  yearsOfExperience: number;
  skills:            string[];
  summary:           string;
  resumePath:        string;
}

const DEFAULTS: UserProfile = {
  firstName:         "",
  lastName:          "",
  email:             "",
  phone:             "",
  linkedinUrl:       "",
  portfolioUrl:      "",
  githubUrl:         "",
  currentRole:       "Software Engineer",
  yearsOfExperience: 0,
  skills:            [],
  summary:           "",
  resumePath:        RESUME_PATH,
};

export function loadProfile(): UserProfile {
  fs.mkdirSync("data", { recursive: true });
  if (!fs.existsSync(PROFILE_FILE)) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(PROFILE_FILE, "utf-8")) as Partial<UserProfile> };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveProfile(profile: Partial<UserProfile>): UserProfile {
  fs.mkdirSync("data", { recursive: true });
  const current = loadProfile();
  const updated = { ...current, ...profile };
  fs.writeFileSync(PROFILE_FILE, JSON.stringify(updated, null, 2));
  // async sync to MongoDB — fire and forget, local file is authoritative
  void syncProfileToDB(updated);
  return updated;
}

async function syncProfileToDB(profile: UserProfile): Promise<void> {
  try {
    await connectDB();
    await Profile.findOneAndUpdate({}, profile, { upsert: true, new: true });
  } catch { /* DB sync is best-effort */ }
}

export function resumeExists(): boolean {
  return fs.existsSync(RESUME_PATH);
}

export { RESUME_PATH };
