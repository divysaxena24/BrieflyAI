import { NextResponse } from "next/server";
import GmailService from "@/lib/services/gmail";
import { logger } from "@/lib/logger";
import { AppError } from "@/lib/errors";
import { gmailPaginationSchema } from "@/lib/validators/gmail";

export const dynamic = "force-dynamic";

export default async function handler(request: Request) {
  logger.info("API: GET /api/gmail-messages received");
  const url = new URL(request.url);
  const maxResults = url.searchParams.get("maxResults");
  const pageToken = url.searchParams.get("pageToken");
  const labels = url.searchParams.getAll("label");

  try {
    const parsed = gmailPaginationSchema.parse({ maxResults: maxResults ? Number(maxResults) : undefined, pageToken: pageToken ?? undefined });
    const result = await GmailService.listMessages({ maxResults: parsed.maxResults, pageToken: parsed.pageToken, labelIds: labels.length ? labels : undefined });
    return NextResponse.json(result);
  } catch (err: any) {
    logger.error("API: /api/gmail-messages error", { error: String(err) });
    if (err instanceof AppError) return NextResponse.json({ message: err.message, code: err.code }, { status: err.status });
    if (err?.name === "ZodError") return NextResponse.json({ message: "Invalid parameters" }, { status: 400 });
    return NextResponse.json({ message: "Internal error" }, { status: 500 });
  }
}
