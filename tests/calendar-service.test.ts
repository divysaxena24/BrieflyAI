import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppError } from '@/lib/errors';

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }));
vi.mock('@/lib/db/queries', () => ({ getUserIntegrationByPlatform: vi.fn(), findUserByAuthId: vi.fn(), logActivity: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/services/integrations/googleTokenManager', () => ({
  default: { getValidAccessToken: vi.fn(), invalidate: vi.fn() },
}));

import { getCurrentUser } from '@/lib/auth';
import { getUserIntegrationByPlatform, findUserByAuthId } from '@/lib/db/queries';
import tokenManager from '@/lib/services/integrations/googleTokenManager';
import { CalendarClient } from '@/lib/services/calendar';
import CalendarService from '@/lib/services/calendar';

describe('CalendarService', () => {
  const mockUser = { id: 'user-1', email: 'test@example.com' };
  const mockIntegration = { id: 'int-1', platform: 'google', userId: 'user-1' };
  const mockToken = { accessToken: 'valid-token' };

  beforeEach(() => {
    vi.clearAllMocks();
    (getCurrentUser as any).mockResolvedValue(mockUser);
    (getUserIntegrationByPlatform as any).mockResolvedValue(mockIntegration);
    (findUserByAuthId as any).mockResolvedValue(mockUser);
    (tokenManager.getValidAccessToken as any).mockResolvedValue(mockToken);
  });

  describe('createClientForUser', () => {
    it('throws AppError when user is not authenticated', async () => {
      (getCurrentUser as any).mockResolvedValue(null);
      await expect(CalendarService.createClientForUser()).rejects.toMatchObject({ code: 'authentication_required', status: 401 });
    });

    it('throws AppError when no Google integration exists', async () => {
      (getUserIntegrationByPlatform as any).mockResolvedValue(null);
      await expect(CalendarService.createClientForUser()).rejects.toMatchObject({ code: 'google_not_connected', status: 404 });
    });

    it('returns client and integration on success', async () => {
      const result = await CalendarService.createClientForUser();
      expect(result.client).toBeDefined();
      expect(result.integration).toEqual(mockIntegration);
    });
  });

  describe('listEvents', () => {
    const mockEventsResponse = {
      items: [
        { id: 'evt-1', summary: 'Meeting', description: 'Discuss project', location: 'Room 1', status: 'confirmed',
          start: { dateTime: '2025-01-15T10:00:00Z' }, end: { dateTime: '2025-01-15T11:00:00Z' },
          organizer: { email: 'org@test.com', displayName: 'Organizer' },
          attendees: [{ email: 'att@test.com', displayName: 'Attendee' }] },
        { id: 'evt-2', summary: 'All-day', status: 'confirmed',
          start: { date: '2025-01-16' }, end: { date: '2025-01-17' } },
      ],
      nextPageToken: 'next-cal-page',
    };

    beforeEach(() => {
      vi.spyOn(CalendarClient.prototype, 'listEvents').mockResolvedValue(mockEventsResponse);
    });

    it('returns events with nextPageToken', async () => {
      const result = await CalendarService.listEvents({ calendarId: 'primary', from: '2025-01-01', to: '2025-01-31' });
      expect(result.events).toHaveLength(2);
      expect(result.nextPageToken).toBe('next-cal-page');
      expect(result.events[0].summary).toBe('Meeting');
      expect(result.events[0].start).toBe('2025-01-15T10:00:00Z');
    });

    it('handles date-only events', async () => {
      const result = await CalendarService.listEvents();
      expect(result.events[1].start).toBe('2025-01-16');
      expect(result.events[1].end).toBe('2025-01-17');
    });

    it('handles empty response', async () => {
      vi.spyOn(CalendarClient.prototype, 'listEvents').mockResolvedValue({});
      const result = await CalendarService.listEvents();
      expect(result.events).toHaveLength(0);
      expect(result.nextPageToken).toBeNull();
    });

    it('passes pagination params', async () => {
      const spy = vi.spyOn(CalendarClient.prototype, 'listEvents').mockResolvedValue({});
      await CalendarService.listEvents({ maxResults: 50, pageToken: 'p-1' });
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ maxResults: 50, pageToken: 'p-1' }));
    });

    it('throws AppError and invalidates token on 401', async () => {
      vi.spyOn(CalendarClient.prototype, 'listEvents').mockRejectedValue({ status: 401 });
      await expect(CalendarService.listEvents()).rejects.toMatchObject({ code: 'authentication_required' });
      expect(tokenManager.invalidate).toHaveBeenCalledWith('int-1');
    });

    it('throws AppError on 429', async () => {
      vi.spyOn(CalendarClient.prototype, 'listEvents').mockRejectedValue({ status: 429 });
      await expect(CalendarService.listEvents()).rejects.toMatchObject({ code: 'rate_limited' });
    });

    it('re-throws AppError directly', async () => {
      vi.spyOn(CalendarClient.prototype, 'listEvents').mockRejectedValue(new AppError('Direct', 400, 'direct'));
      await expect(CalendarService.listEvents()).rejects.toMatchObject({ code: 'direct' });
    });
  });

  describe('getEvent', () => {
    beforeEach(() => {
      vi.spyOn(CalendarClient.prototype, 'getEvent').mockResolvedValue({
        id: 'evt-1', summary: 'Meeting', description: 'Discuss', location: 'Room 1', status: 'confirmed',
        htmlLink: 'https://calendar.google.com/event?id=evt-1', recurrence: ['RRULE:FREQ=WEEKLY'],
        start: { dateTime: '2025-01-15T10:00:00Z' }, end: { dateTime: '2025-01-15T11:00:00Z' },
        organizer: { email: 'org@test.com' }, attendees: [],
      });
    });

    it('returns event detail', async () => {
      const result = await CalendarService.getEvent('evt-1');
      expect(result.summary).toBe('Meeting');
      expect(result.htmlLink).toBe('https://calendar.google.com/event?id=evt-1');
      expect(result.recurrence).toEqual(['RRULE:FREQ=WEEKLY']);
    });

    it('throws AppError on 404', async () => {
      vi.spyOn(CalendarClient.prototype, 'getEvent').mockRejectedValue({ status: 404 });
      await expect(CalendarService.getEvent('evt-1')).rejects.toMatchObject({ code: 'not_found', status: 404 });
    });

    it('does not invalidate token on 403', async () => {
      vi.spyOn(CalendarClient.prototype, 'getEvent').mockRejectedValue({ status: 403 });
      await expect(CalendarService.getEvent('evt-1')).rejects.toThrow(AppError);
      expect(tokenManager.invalidate).not.toHaveBeenCalled();
    });
  });

  describe('listCalendars', () => {
    beforeEach(() => {
      vi.spyOn(CalendarClient.prototype, 'listCalendars').mockResolvedValue({
        items: [
          { id: 'cal-1', summary: 'Work', timeZone: 'UTC', accessRole: 'owner' },
          { id: 'cal-2', summary: 'Personal', timeZone: 'America/New_York', accessRole: 'reader' },
        ],
      });
    });

    it('returns calendar list', async () => {
      const result = await CalendarService.listCalendars();
      expect(result).toHaveLength(2);
      expect(result[0].summary).toBe('Work');
      expect(result[1].accessRole).toBe('reader');
    });
  });

  describe('searchEvents', () => {
    beforeEach(() => {
      vi.spyOn(CalendarClient.prototype, 'listEvents').mockResolvedValue({
        items: [{ id: 'evt-1', summary: 'Found', status: 'confirmed', start: { dateTime: '2025-01-15T10:00:00Z' }, end: { dateTime: '2025-01-15T11:00:00Z' } }],
        nextPageToken: null,
      });
    });

    it('searches events with query', async () => {
      const result = await CalendarService.searchEvents('Meeting', 'primary', 10, 'p-1');
      expect(result.events).toHaveLength(1);
      expect(result.events[0].summary).toBe('Found');
    });

    it('invalidates token on 401 in searchEvents', async () => {
      vi.spyOn(CalendarClient.prototype, 'listEvents').mockRejectedValue({ status: 401 });
      await expect(CalendarService.searchEvents('Meeting')).rejects.toMatchObject({ code: 'authentication_required' });
      expect(tokenManager.invalidate).toHaveBeenCalledWith('int-1');
    });
  });
});
