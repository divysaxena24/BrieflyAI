export type LogLevel = "debug" | "info" | "warn" | "error";

function timestamp() {
  return new Date().toISOString();
}

export const logger = {
  debug: (...args: any[]) => console.debug(`[DEBUG] [${timestamp()}]`, ...args),
  info: (...args: any[]) => console.info(`[INFO]  [${timestamp()}]`, ...args),
  warn: (...args: any[]) => console.warn(`[WARN]  [${timestamp()}]`, ...args),
  error: (...args: any[]) => console.error(`[ERROR] [${timestamp()}]`, ...args),
};

export default logger;
