export interface Job {
  id: string;
  title: string;
  company: string;
  location: string;
  url: string;
  source: JobSource;
  postedAt?: string;
  salary?: string;
  description?: string;
  tags?: string[];
  easyApply: boolean;
  foundAt: string;
}

export interface ApplicationResult {
  job: Job;
  status: "applied" | "skipped" | "failed" | "already_applied";
  appliedAt?: string;
  error?: string;
}

export interface SearchConfig {
  keywords: string[];
  location: string;
  remote: boolean;
  maxResults: number;
  blacklistCompanies: string[];
  requiredKeywords: string[];
  excludeKeywords: string[];
}

export interface ResumeConfig {
  path: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  linkedinUrl?: string;
  portfolioUrl?: string;
  yearsOfExperience: number;
}

export interface JobsConfig {
  search: SearchConfig;
  resume: ResumeConfig;
  sources: {
    linkedin: boolean;
    indeed: boolean;
    greenhouse: boolean;
    lever: boolean;
    naukri: boolean;
    wellfound: boolean;
    weworkremotely: boolean;
  };
  autoApply: boolean;
  maxApplicationsPerRun: number;
}

export type JobSource =
  | "linkedin"
  | "indeed"
  | "greenhouse"
  | "lever"
  | "naukri"
  | "wellfound"
  | "weworkremotely";
