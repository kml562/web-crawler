import mongoose, { Schema } from "mongoose";
import type { UserProfile } from "../../utils/profile.js";

const ProfileSchema = new Schema<UserProfile>({
  firstName:         { type: String, default: "" },
  lastName:          { type: String, default: "" },
  email:             { type: String, default: "" },
  phone:             { type: String, default: "" },
  linkedinUrl:       { type: String, default: "" },
  portfolioUrl:      { type: String, default: "" },
  githubUrl:         { type: String, default: "" },
  currentRole:       { type: String, default: "Software Engineer" },
  yearsOfExperience: { type: Number, default: 0 },
  skills:            [String],
  summary:           { type: String, default: "" },
  resumePath:        { type: String, default: "" },
}, { timestamps: true });

export const Profile = mongoose.models["Profile"] as mongoose.Model<UserProfile>
  ?? mongoose.model<UserProfile>("Profile", ProfileSchema);
