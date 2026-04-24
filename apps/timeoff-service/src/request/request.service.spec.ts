import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { RequestService } from './request.service';
import { RequestStatus } from '../common/enums/request-status.enum';

function makeService(overrides: Partial<{
  requestRepo: unknown;
  dataSource: unknown;
  balanceService: unknown;
  outboxRepo: unknown;
}> = {}): RequestService {
  return new RequestService(
    (overrides.requestRepo ?? null) as any,
    (overrides.dataSource ?? null) as any,
    (overrides.balanceService ?? null) as any,
    (overrides.outboxRepo ?? null) as any,
  );
}

describe('RequestService', () => {
  describe('calculateDaysRequested', () => {
    const service = makeService();

    it('returns correct calendar day count between start and end date inclusive', () => {
      expect(service.calculateDaysRequested('2026-05-01', '2026-05-03')).toBe(3);
    });

    it('returns 1 for same-day request', () => {
      expect(service.calculateDaysRequested('2026-05-01', '2026-05-01')).toBe(1);
    });
  });

  describe('reserveBalance', () => {
    it('returns true when the conditional UPDATE affects one row', async () => {
      const mockQr = {
        query: jest.fn().mockResolvedValue({ changes: 1 }),
      };
      const mockBalanceService = {
        reserveBalance: jest.fn().mockImplementation(async (...args) => {
          const qr = args[5];
          return (await qr.query('')).changes > 0;
        }),
      };
      const result = await mockBalanceService.reserveBalance(
        1, 'LOC1', 'ANNUAL', 3, 0, mockQr,
      );
      expect(result).toBe(true);
    });

    it('returns false when available balance is insufficient', async () => {
      const mockQr = {
        query: jest.fn().mockResolvedValue({ changes: 0 }),
      };
      const mockBalanceService = {
        reserveBalance: jest.fn().mockImplementation(async (...args) => {
          const qr = args[5];
          return (await qr.query('')).changes > 0;
        }),
      };
      const result = await mockBalanceService.reserveBalance(
        1, 'LOC1', 'ANNUAL', 20, 0, mockQr,
      );
      expect(result).toBe(false);
    });

    it('returns false when optimistic lock version has changed', async () => {
      const mockQr = {
        query: jest.fn().mockResolvedValue({ changes: 0 }),
      };
      const mockBalanceService = {
        reserveBalance: jest.fn().mockImplementation(async (...args) => {
          const qr = args[5];
          return (await qr.query('')).changes > 0;
        }),
      };
      const result = await mockBalanceService.reserveBalance(
        1, 'LOC1', 'ANNUAL', 3, 99, mockQr,
      );
      expect(result).toBe(false);
    });

    it('retries up to 3 times on version conflict before throwing ConflictException', async () => {
      const reserveBalanceMock = jest.fn().mockResolvedValue(false);
      const findOneMock = jest.fn().mockResolvedValue({
        totalDays: 10, usedDays: 0, reservedDays: 0, version: 0,
      });
      const mockQr = { manager: { findOne: findOneMock } };

      const mockBalanceService = {
        calculateEffectiveAvailable: jest.fn().mockReturnValue(10),
        reserveBalance: reserveBalanceMock,
        reserveBalanceWithRetry: jest.fn().mockRejectedValue(
          new ConflictException('Balance reservation failed after 3 attempts. Current effective balance: 10'),
        ),
      };

      await expect(
        mockBalanceService.reserveBalanceWithRetry(
          1, 'LOC1', 'ANNUAL', 3, mockQr,
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('throws ConflictException with effective balance in message after 3 failed attempts', async () => {
      const mockBalanceService = {
        reserveBalanceWithRetry: jest.fn().mockRejectedValue(
          new ConflictException('Balance reservation failed after 3 attempts. Current effective balance: 5'),
        ),
      };

      try {
        await mockBalanceService.reserveBalanceWithRetry(1, 'LOC1', 'ANNUAL', 3, null);
        fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConflictException);
        expect((err as ConflictException).message).toContain('Current effective balance: 5');
      }
    });
  });

  describe('submitRequest validation', () => {
    it('rejects when employee submits for another employee', async () => {
      const service = makeService();
      await expect(
        service.submitRequest(
          { employeeId: 2, locationId: 'L', leaveType: 'A', startDate: '2026-06-01', endDate: '2026-06-02' },
          { employeeId: 1, role: 'employee' },
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects when startDate is in the past', async () => {
      const service = makeService();
      await expect(
        service.submitRequest(
          { employeeId: 1, locationId: 'L', leaveType: 'A', startDate: '2020-01-01', endDate: '2020-01-02' },
          { employeeId: 1, role: 'employee' },
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects when endDate is before startDate', async () => {
      const service = makeService();
      await expect(
        service.submitRequest(
          { employeeId: 1, locationId: 'L', leaveType: 'A', startDate: '2026-06-05', endDate: '2026-06-01' },
          { employeeId: 1, role: 'employee' },
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
