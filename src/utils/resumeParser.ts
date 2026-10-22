import Anthropic from "@anthropic-ai/sdk";
// pdf-parse ships as CJS with a .default property under ESM interop
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse: (buf: Buffer) => Promise<{ text: string }> = require("pdf-parse");
import type { UserProfile } from "./profile.js";

export type ExtractedProfile = Omit<UserProfile, "resumePath">;

export async function extractProfileFromPDF(pdfBuffer: Buffer): Promise<ExtractedProfile> {
  // 1. Extract raw text from PDF
  const parsed = await pdfParse(pdfBuffer);
  const resumeText = parsed.text.trim();

  if (!resumeText) throw new Error("Could not extract text from PDF");

  // 2. Call Claude to parse structured data
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey || apiKey === "your_anthropic_api_key_here") {
    throw new Error("ANTHROPIC_API_KEY not configured — PDF text extracted but auto-fill unavailable");
  }
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: "claude-haiku-5-5",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `Extract profile information from this resume and return ONLY valid JSON with no explanation or markdown.

Resume text:
${resumeText.slice(0, 8000)}

Return JSON matching exactly this structure (use empty string "" for missing fields, empty array [] for missing skills):
{
  "firstName": "",
  "lastName": "",
  "email": "",
  "phone": "",
  "linkedinUrl": "",
  "githubUrl": "",
  "portfolioUrl": "",
  "currentRole": "",
  "yearsOfExperience": 0,
  "skills": [],
  "summary": ""
}`,
      },
    ],
  });

  const raw = response.content[0]?.type === "text" ? response.content[0].text.trim() : "";

  // Strip any accidental markdown fences
  const json = raw.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();

  const extracted = JSON.parse(json) as ExtractedProfile;
  return extracted;
}
