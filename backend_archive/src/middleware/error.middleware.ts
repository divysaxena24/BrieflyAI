import { Request, Response, NextFunction } from "express";
import { config } from "../config";
import { HTTP_STATUS } from "../constants";

export interface AppError extends Error {
  statusCode?: number;
  isOperational?: boolean;
}

export function errorMiddleware(
  err: AppError,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  const statusCode = err.statusCode ?? HTTP_STATUS.INTERNAL_SERVER_ERROR;
  const message = err.isOperational ? err.message : "Internal server error";

  console.error(`[ERROR] ${err.message}`, config.isDevelopment ? err.stack : "");

  res.status(statusCode).json({
    success: false,
    message,
    ...(config.isDevelopment && { stack: err.stack }),
    timestamp: new Date().toISOString(),
  });
}
