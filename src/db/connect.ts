import mongoose from "mongoose";
import { logger } from "../utils/logger.js";

let connected = false;

export async function connectDB(): Promise<void> {
  if (connected) return;
  const uri = process.env["MONGODB_URI"];
  if (!uri) throw new Error("MONGODB_URI not set in .env");
  await mongoose.connect(uri);
  connected = true;
  logger.success("MongoDB connected", { service: "db" });
}
