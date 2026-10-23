import mongoose from "mongoose";

const SystemLogSchema = new mongoose.Schema(
  {
    level:     { type: String, required: true, enum: ["error", "warn", "info", "debug"] },
    message:   { type: String, required: true },
    service:   { type: String, default: "crawler" },  // e.g. "naukri", "server", "linkedin"
    meta:      { type: mongoose.Schema.Types.Mixed },  // any extra context
    timestamp: { type: Date, default: Date.now },
  },
  { capped: { size: 10 * 1024 * 1024, max: 5000 } } // 10MB capped collection, keep last 5000 logs
);

SystemLogSchema.index({ timestamp: -1 });
SystemLogSchema.index({ level: 1, timestamp: -1 });
SystemLogSchema.index({ service: 1, timestamp: -1 });

export const SystemLog = mongoose.model("SystemLog", SystemLogSchema);
