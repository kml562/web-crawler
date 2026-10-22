import mongoose, { Schema, type Document } from "mongoose";
import type { ApplicationResult } from "../../types/index.js";

export interface ApplicationDoc extends Document {
  jobId: string;
  title: string;
  company: string;
  location: string;
  url: string;
  source: string;
  easyApply: boolean;
  foundAt: string;
  status: string;
  appliedAt: string;
  error: string;
  raw: string; // full JSON snapshot
}

const ApplicationSchema = new Schema<ApplicationDoc>({
  jobId:     { type: String, required: true, unique: true },
  title:     { type: String, required: true },
  company:   { type: String, required: true },
  location:  String,
  url:       String,
  source:    String,
  easyApply: Boolean,
  foundAt:   String,
  status:    { type: String, required: true },
  appliedAt: String,
  error:     String,
  raw:       { type: String, required: true },
}, { timestamps: true });

export const Application = mongoose.models["Application"] as mongoose.Model<ApplicationDoc>
  ?? mongoose.model<ApplicationDoc>("Application", ApplicationSchema);
