import { NextResponse } from "next/server";
import GmailService from "@/lib/services/gmail";
import { logger } from "@/lib/logger";
import { AppError } from "@/lib/errors";

export const dynamic = "force-dynamic";

export default async function handler() {
  logger.info("API: GET /api/gmail-labels received");
  try {
    const labels = await GmailService.listLabels();
    return NextResponse.json({ labels });
  } catch (err: any) {
    logger.error("API: /api/gmail-labels error", { error: String(err) });
    if (err instanceof AppError) return NextResponse.json({ message: err.message, code: err.code }, { status: err.status });
    return NextResponse.json({ message: "Internal error" }, { status: 500 });
  }
}
