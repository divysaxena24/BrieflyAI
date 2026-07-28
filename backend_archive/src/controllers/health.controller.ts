import { Request, Response } from "express";
import { config } from "../config";
import { HTTP_STATUS } from "../constants";

export function getHealth(_req: Request, res: Response): void {
  res.status(HTTP_STATUS.OK).json({
    success: true,
    message: "BrieflyAI Backend is running",
    timestamp: new Date().toISOString(),
    environment: config.nodeEnv,
  });
}
