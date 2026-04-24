import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { BalanceService } from './balance.service';

function makeBalance(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    employeeId: 1,
    locationId: 'LOC1',
    leaveType: 'ANNUAL',
    totalDays: 10,
    usedDays: 0,
    reservedDays: 0,
    version: 0,
    lastSyncedAt: null,
    hcmVersion: '1',
    ...overrides,
  } as any;
}

function makeService(overrides: { repo?: unknown; ds?: unknown } = {}) {
  return new BalanceService(
    (overrides.repo ?? null) as any,
    (overrides.ds ?? null) as any,
  );
}

describe('BalanceService', () => {
  describe('calculateEffectiveAvailable', () => {
    let svc: BalanceService;
    beforeEach(() => { svc = makeService(); });

    it('returns total minus used minus reserved', () => {
      expect(svc.calculateEffectiveAvailable(10, 3, 2)).toBe(5);
    });

    it('returns 0 when reserved plus used equals total', () => {
      expect(svc.calculateEffectiveAvailable(10, 5, 5)).toBe(0);
    });

    it('returns 0 when reserved plus used exceeds total (clamp at zero)', () => {
      expect(svc.calculateEffectiveAvailable(10, 7, 5)).toBe(0);
    });

    it('handles decimal values correctly', () => {
      expect(svc.calculateEffectiveAvailable(10.5, 2.5, 3.0)).toBeCloseTo(5.0);
    });
  });

  describe('detectDiscrepancy', () => {
    let svc: BalanceService;
    beforeEach(() => { svc = makeService(); });

    it('returns true when hcm total is less than used plus reserved', () => {
      expect(svc.detectDiscrepancy(8, 5, 5)).toBe(true);
    });

    it('returns false when hcm total equals used plus reserved', () => {
      expect(svc.detectDiscrepancy(10, 5, 5)).toBe(false);
    });

    it('returns false when hcm total is greater than used plus reserved', () => {
      expect(svc.detectDiscrepancy(15, 5, 5)).toBe(false);
    });
  });

  describe('getByEmployee', () => {
    it('returns balances with effectiveAvailable computed', async () => {
      const balance = makeBalance({ totalDays: 10, usedDays: 3, reservedDays: 2 });
      const repo = { find: jest.fn().mockResolvedValue([balance]) };
      const svc = makeService({ repo });

      const result = await svc.getByEmployee(1);

      expect(result).toHaveLength(1);
      expect(result[0].effectiveAvailable).toBe(5);
    });

    it('returns empty array when no balances exist', async () => {
      const repo = { find: jest.fn().mockResolvedValue([]) };
      const svc = makeService({ repo });
      const result = await svc.getByEmployee(99);
      expect(result).toEqual([]);
    });
  });

  describe('getByEmployeeAndLocation', () => {
    it('returns balances with effectiveAvailable', async () => {
      const balance = makeBalance({ totalDays: 8, usedDays: 2, reservedDays: 1 });
      const repo = { find: jest.fn().mockResolvedValue([balance]) };
      const svc = makeService({ repo });

      const result = await svc.getByEmployeeAndLocation(1, 'LOC1');
      expect(result[0].effectiveAvailable).toBe(5);
    });

    it('throws NotFoundException when no balances exist', async () => {
      const repo = { find: jest.fn().mockResolvedValue([]) };
      const svc = makeService({ repo });
      await expect(svc.getByEmployeeAndLocation(99, 'LOC99')).rejects.toThrow(NotFoundException);
    });
  });

  describe('upsertFromHcm', () => {
    it('creates a new balance when none exists', async () => {
      const saved: unknown[] = [];
      const repo = {
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation((d) => d),
        save: jest.fn().mockImplementation((b) => { saved.push(b); return Promise.resolve(b); }),
      };
      const svc = makeService({ repo });

      const result = await svc.upsertFromHcm({
        employeeId: 1, locationId: 'LOC1', leaveType: 'ANNUAL', totalDays: 10, hcmVersion: '1',
      });

      expect(repo.save).toHaveBeenCalledTimes(1);
      expect(result.isDiscrepancy).toBe(false);
    });

    it('updates an existing balance and detects discrepancy', async () => {
      const existing = makeBalance({ totalDays: 10, usedDays: 8, reservedDays: 4 });
      const repo = {
        findOne: jest.fn().mockResolvedValue(existing),
        create: jest.fn(),
        save: jest.fn().mockResolvedValue(existing),
      };
      const svc = makeService({ repo });

      const result = await svc.upsertFromHcm({
        employeeId: 1, locationId: 'LOC1', leaveType: 'ANNUAL', totalDays: 6, hcmVersion: '2',
      });

      expect(result.isDiscrepancy).toBe(true);
    });

    it('updates an existing balance without discrepancy', async () => {
      const existing = makeBalance({ totalDays: 10, usedDays: 2, reservedDays: 2 });
      const repo = {
        findOne: jest.fn().mockResolvedValue(existing),
        create: jest.fn(),
        save: jest.fn().mockResolvedValue(existing),
      };
      const svc = makeService({ repo });

      const result = await svc.upsertFromHcm({
        employeeId: 1, locationId: 'LOC1', leaveType: 'ANNUAL', totalDays: 10, hcmVersion: '2',
      });

      expect(result.isDiscrepancy).toBe(false);
    });
  });

  describe('reserveBalance', () => {
    it('returns true when UPDATE affects 1 row', async () => {
      const qr = { query: jest.fn().mockResolvedValue({ affected: 1, records: [], raw: 1 }) };
      const svc = makeService();

      const result = await svc.reserveBalance(1, 'LOC1', 'ANNUAL', 5, 0, qr as any);
      expect(result).toBe(true);
    });

    it('returns false when UPDATE affects 0 rows (version conflict)', async () => {
      const qr = { query: jest.fn().mockResolvedValue({ affected: 0, records: [], raw: 0 }) };
      const svc = makeService();

      const result = await svc.reserveBalance(1, 'LOC1', 'ANNUAL', 5, 0, qr as any);
      expect(result).toBe(false);
    });

    it('returns false when result has no affected field (nullish coalescing fallback)', async () => {
      const qr = { query: jest.fn().mockResolvedValue({ records: [], raw: 0 }) };
      const svc = makeService();

      const result = await svc.reserveBalance(1, 'LOC1', 'ANNUAL', 5, 0, qr as any);
      expect(result).toBe(false);
    });
  });

  describe('reserveBalanceWithRetry', () => {
    it('succeeds on the first attempt', async () => {
      const balance = makeBalance({ totalDays: 10, usedDays: 0, reservedDays: 0, version: 0 });
      const qr = {
        manager: { findOne: jest.fn().mockResolvedValue(balance) },
        query: jest.fn().mockResolvedValue({ affected: 1, records: [], raw: 1 }),
      };
      const svc = makeService();

      await expect(svc.reserveBalanceWithRetry(1, 'LOC1', 'ANNUAL', 5, qr as any)).resolves.not.toThrow();
    });

    it('retries on version conflict and succeeds on second attempt', async () => {
      const balance = makeBalance({ totalDays: 10, usedDays: 0, reservedDays: 0, version: 0 });
      const qr = {
        manager: { findOne: jest.fn().mockResolvedValue(balance) },
        query: jest.fn()
          .mockResolvedValueOnce({ affected: 0, records: [], raw: 0 })  // first attempt fails
          .mockResolvedValueOnce({ affected: 1, records: [], raw: 1 }), // second succeeds
      };
      const svc = makeService();

      await expect(svc.reserveBalanceWithRetry(1, 'LOC1', 'ANNUAL', 5, qr as any)).resolves.not.toThrow();
      expect(qr.query).toHaveBeenCalledTimes(2);
    });

    it('throws UnprocessableEntityException when balance not found', async () => {
      const qr = {
        manager: { findOne: jest.fn().mockResolvedValue(null) },
        query: jest.fn(),
      };
      const svc = makeService();

      await expect(
        svc.reserveBalanceWithRetry(99, 'LOC99', 'ANNUAL', 5, qr as any),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('throws UnprocessableEntityException when effective balance is insufficient', async () => {
      const balance = makeBalance({ totalDays: 3, usedDays: 0, reservedDays: 0, version: 0 });
      const qr = {
        manager: { findOne: jest.fn().mockResolvedValue(balance) },
        query: jest.fn(),
      };
      const svc = makeService();

      await expect(
        svc.reserveBalanceWithRetry(1, 'LOC1', 'ANNUAL', 10, qr as any),
      ).rejects.toThrow(UnprocessableEntityException);
      expect(qr.query).not.toHaveBeenCalled();
    });

    it('throws ConflictException after exhausting all retry attempts', async () => {
      const balance = makeBalance({ totalDays: 10, usedDays: 0, reservedDays: 0, version: 0 });
      const qr = {
        manager: { findOne: jest.fn().mockResolvedValue(balance) },
        query: jest.fn().mockResolvedValue({ affected: 0, records: [], raw: 0 }),
      };
      const svc = makeService();

      await expect(
        svc.reserveBalanceWithRetry(1, 'LOC1', 'ANNUAL', 5, qr as any),
      ).rejects.toThrow(ConflictException);
      expect(qr.query).toHaveBeenCalledTimes(3);
    });

    it('throws ConflictException with effective balance 0 when balance disappears after retries', async () => {
      const balance = makeBalance({ totalDays: 10, usedDays: 0, reservedDays: 0, version: 0 });
      let findOneCallCount = 0;
      const qr = {
        manager: {
          findOne: jest.fn().mockImplementation(() => {
            findOneCallCount += 1;
            return findOneCallCount <= 3 ? Promise.resolve(balance) : Promise.resolve(null);
          }),
        },
        query: jest.fn().mockResolvedValue({ affected: 0, records: [], raw: 0 }),
      };
      const svc = makeService();

      await expect(
        svc.reserveBalanceWithRetry(1, 'LOC1', 'ANNUAL', 5, qr as any),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('releaseReserved', () => {
    it('calls queryRunner.query with the correct UPDATE', async () => {
      const qr = { query: jest.fn().mockResolvedValue({}) };
      const svc = makeService();

      await svc.releaseReserved(1, 'LOC1', 'ANNUAL', 5, qr as any);

      expect(qr.query).toHaveBeenCalledTimes(1);
      const [sql, params] = qr.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/reserved_days/i);
      expect(params).toContain(5);
    });
  });

  // ── confirmDeduction ──────────────────────────────────────────────────────

  describe('confirmDeduction', () => {
    it('moves reserved days to used days', async () => {
      const qr = { query: jest.fn().mockResolvedValue({}) };
      const svc = makeService();

      await svc.confirmDeduction(1, 'LOC1', 'ANNUAL', 5, qr as any);

      expect(qr.query).toHaveBeenCalledTimes(1);
      const [sql, params] = qr.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/used_days/i);
      expect(params).toContain(5);
    });
  });
});
