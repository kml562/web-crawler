import { connectDB } from "../db/connect.js";
import { Application } from "../db/models/Application.js";
import type { ApplicationResult } from "../types/index.js";

export async function appendResult(result: ApplicationResult): Promise<void> {
  await connectDB();
  const { job, status, appliedAt, error } = result;
  await Application.findOneAndUpdate(
    { jobId: job.id },
    {
      jobId: job.id,
      title: job.title,
      company: job.company,
      location: job.location ?? "",
      url: job.url,
      source: job.source,
      easyApply: !!job.easyApply,
      foundAt: job.foundAt ?? "",
      status,
      appliedAt: appliedAt ?? "",
      error: error ?? "",
      raw: JSON.stringify(result),
    },
    { upsert: true, new: true }
  );
}

export async function hasApplied(jobId: string): Promise<boolean> {
  await connectDB();
  const doc = await Application.findOne({ jobId, status: "applied" });
  return !!doc;
}

export async function loadApplied(): Promise<ApplicationResult[]> {
  await connectDB();
  const docs = await Application.find().sort({ createdAt: -1 });
  return docs.map((d) => JSON.parse(d.raw) as ApplicationResult);
}

export async function getSummary() {
  await connectDB();
  const [total, applied, failed, skipped] = await Promise.all([
    Application.countDocuments(),
    Application.countDocuments({ status: "applied" }),
    Application.countDocuments({ status: "failed" }),
    Application.countDocuments({ status: "skipped" }),
  ]);
  return { total, applied, failed, skipped };
}
