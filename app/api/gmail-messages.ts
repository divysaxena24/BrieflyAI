import { NextResponse } from "next/server";
import GmailService from "@/lib/services/gmail";
import { logger } from "@/lib/logger";
import { AppError } from "@/lib/errors";

export const dynamic = "force-dynamic";

export default async function handler(request: Request) {
  logger.info("API: GET /api/gmail-messages received");
  const url = new URL(request.url);
  const maxResults = url.searchParams.get("maxResults");
  const pageToken = url.searchParams.get("pageToken");
  const labels = url.searchParams.getAll("label");

  const parsedMax = maxResults ? Number(maxResults) : undefined;
  try {
    if (parsedMax !== undefined && (isNaN(parsedMax) || parsedMax < 1 || parsedMax > 100)) {
      return NextResponse.json({ message: "Invalid maxResults" }, { status: 400 });
    }

    const result = await GmailService.listMessages({ maxResults: parsedMax, pageToken: pageToken ?? undefined, labelIds: labels.length ? labels : undefined });
    return NextResponse.json(result);
  } catch (err: any) {
    logger.error("API: /api/gmail-messages error", { error: String(err) });
    if (err instanceof AppError) return NextResponse.json({ message: err.message, code: err.code }, { status: err.status });
    return NextResponse.json({ message: "Internal error" }, { status: 500 });
  }
}
