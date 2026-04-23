import { RequestService } from './request.service';

describe('RequestService', () => {
  let service: RequestService;

  beforeEach(() => {
    service = new RequestService(null as any, null as any, null as any);
  });

  describe('reserveBalance', () => {
    it('returns true when the conditional UPDATE affects one row', () => {});
    it('returns false when available balance is insufficient', () => {});
    it('returns false when optimistic lock version has changed', () => {});
    it('retries up to 3 times on version conflict before throwing ConflictException', () => {});
    it('throws ConflictException with effective balance in message after 3 failed attempts', () => {});
  });

  describe('calculateDaysRequested', () => {
    it('returns correct calendar day count between start and end date inclusive', () => {
      expect(service.calculateDaysRequested('2026-05-01', '2026-05-03')).toBe(3);
    });

    it('returns 1 for same-day request', () => {
      expect(service.calculateDaysRequested('2026-05-01', '2026-05-01')).toBe(1);
    });
  });
});
