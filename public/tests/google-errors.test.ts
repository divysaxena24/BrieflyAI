import { describe, it, expect } from 'vitest';
import { mapStatusToAppError } from '@/lib/services/google-errors';

describe('GoogleErrors', () => {
  it('maps 401 to authentication_required', () => {
    const e = mapStatusToAppError(401);
    expect(e.status).toBe(401);
    expect(e.code).toBe('authentication_required');
  });

  it('maps 403 to permission_denied', () => {
    const e = mapStatusToAppError(403);
    expect(e.status).toBe(403);
    expect(e.code).toBe('permission_denied');
  });

  it('maps 429 to rate_limited', () => {
    const e = mapStatusToAppError(429);
    expect(e.status).toBe(429);
    expect(e.code).toBe('rate_limited');
  });

  it('maps 500 to google_server_error', () => {
    const e = mapStatusToAppError(500);
    expect(e.status).toBe(502);
    expect(e.code).toBe('google_server_error');
  });
});
