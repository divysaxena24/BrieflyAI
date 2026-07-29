import { logger } from '@/lib/logger';

function attach(meta?: Record<string, any>) {
  return { platform: 'google', ...(meta ?? {}) };
}

export const glogger = {
  debug: (msg: string, meta?: Record<string, any>) => logger.debug(msg, attach(meta)),
  info: (msg: string, meta?: Record<string, any>) => logger.info(msg, attach(meta)),
  warn: (msg: string, meta?: Record<string, any>) => logger.warn(msg, attach(meta)),
  error: (msg: string, meta?: Record<string, any>) => logger.error(msg, attach(meta)),
};

export default glogger;
