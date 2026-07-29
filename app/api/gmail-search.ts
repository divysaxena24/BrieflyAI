import { NextResponse } from "next/server";
import GmailService from "@/lib/services/gmail";
import { logger } from "@/lib/logger";
import { AppError } from "@/lib/errors";
import { gmailSearchSchema } from "@/lib/validators/gmail";

export const dynamic = "force-dynamic";

export default async function handler(request: Request) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const maxResults = url.searchParams.get("maxResults");
  const pageToken = url.searchParams.get("pageToken");

  logger.info("API: GET /api/gmail-search received", { q });

  try {
    const parsed = gmailSearchSchema.parse({ query: q, maxResults: maxResults ? Number(maxResults) : undefined });
    const result = await GmailService.searchMessages(parsed.query, parsed.maxResults ?? 20, pageToken ?? undefined);
    return NextResponse.json(result);
  } catch (err: any) {
    logger.error("API: /api/gmail-search error", { error: String(err) });
    if (err instanceof AppError) return NextResponse.json({ message: err.message, code: err.code }, { status: err.status });
    if (err?.name === "ZodError") return NextResponse.json({ message: "Invalid query" }, { status: 400 });
    return NextResponse.json({ message: "Internal error" }, { status: 500 });
  }
}
