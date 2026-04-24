import { NotFoundException } from '@nestjs/common';
import { SyncService, BatchRecord } from './sync.service';
import { SyncLogStatus, SyncType } from './sync-log.entity';
import { OutboxEventStatus } from '../outbox/outbox.entity';
import { RequestStatus } from '../common/enums/request-status.enum';

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeBalance(overrides: Partial<{
  id: number; employeeId: number; locationId: string; leaveType: string;
  totalDays: number; usedDays: number; reservedDays: number; hcmVersion: string; lastSyncedAt: Date;
}> = {}) {
  return {
    id: 1, employeeId: 1, locationId: 'LOC1', leaveType: 'ANNUAL',
    totalDays: 10, usedDays: 0, reservedDays: 0, hcmVersion: '1',
    version: 0, lastSyncedAt: null,
    ...overrides,
  } as any;
}

function makeSyncService(overrides: Partial<{
  balanceRepo: unknown;
  syncLogRepo: unknown;
  requestRepo: unknown;
  outboxRepo: unknown;
  balanceService: unknown;
  hcmClient: unknown;
  dataSource: unknown;
  configService: unknown;
}> = {}): SyncService {
  return new SyncService(
    (overrides.balanceRepo ?? null) as any,
    (overrides.syncLogRepo ?? null) as any,
    (overrides.requestRepo ?? null) as any,
    (overrides.outboxRepo ?? null) as any,
    (overrides.balanceService ?? null) as any,
    (overrides.hcmClient ?? null) as any,
    (overrides.dataSource ?? null) as any,
    (overrides.configService ?? { get: jest.fn() }) as any,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SyncService', () => {
  describe('processBatchPayload', () => {
    it('upserts balance records from HCM batch', async () => {
      const saved: unknown[] = [];
      const mockQr = {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        commitTransaction: jest.fn(),
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
        manager: {
          findOne: jest.fn().mockResolvedValue(null), // new record
          create: jest.fn().mockImplementation((_, data) => data),
          save: jest.fn().mockImplementation((_, d) => { saved.push(d); return Promise.resolve(d); }),
          find: jest.fn().mockResolvedValue([]),
        },
      };

      const mockSyncLogRepo = {
        create: jest.fn().mockImplementation((d) => d),
        save: jest.fn().mockResolvedValue({ id: 1 }),
        update: jest.fn().mockResolvedValue({}),
      };

      const mockBalanceService = {
        detectDiscrepancy: jest.fn().mockReturnValue(false),
      };

      const mockDataSource = {
        createQueryRunner: jest.fn().mockReturnValue(mockQr),
      };

      const service = makeSyncService({
        syncLogRepo: mockSyncLogRepo,
        balanceService: mockBalanceService,
        dataSource: mockDataSource,
      });

      const records: BatchRecord[] = [
        { employeeId: 1, locationId: 'LOC1', leaveType: 'ANNUAL', totalDays: 10, hcmVersion: '1' },
        { employeeId: 2, locationId: 'LOC1', leaveType: 'ANNUAL', totalDays: 5, hcmVersion: '1' },
      ];

      const result = await service.processBatchPayload(records);

      expect(result.recordsProcessed).toBe(2);
      expect(mockQr.commitTransaction).toHaveBeenCalledTimes(1);
    });

    it('logs discrepancy when hcm total is less than used plus reserved', async () => {
      const existingBalance = makeBalance({ totalDays: 8, usedDays: 5, reservedDays: 4 });

      const mockQr = {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        commitTransaction: jest.fn(),
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
        manager: {
          findOne: jest.fn().mockResolvedValue(existingBalance),
          create: jest.fn().mockImplementation((_, d) => d),
          save: jest.fn().mockResolvedValue(existingBalance),
          find: jest.fn().mockResolvedValue([]),
        },
      };

      const mockSyncLogRepo = {
        create: jest.fn().mockImplementation((d) => d),
        save: jest.fn().mockResolvedValue({ id: 1 }),
        update: jest.fn().mockResolvedValue({}),
      };

      const mockBalanceService = {
        detectDiscrepancy: jest.fn().mockReturnValue(true),
      };

      const mockDataSource = {
        createQueryRunner: jest.fn().mockReturnValue(mockQr),
      };

      const service = makeSyncService({
        syncLogRepo: mockSyncLogRepo,
        balanceService: mockBalanceService,
        dataSource: mockDataSource,
      });

      const result = await service.processBatchPayload([
        { employeeId: 1, locationId: 'LOC1', leaveType: 'ANNUAL', totalDays: 6, hcmVersion: '2' },
      ]);

      expect(result.discrepancies).toBe(1);
    });

    it('does not log discrepancy when totals are consistent', async () => {
      const existingBalance = makeBalance({ totalDays: 10, usedDays: 3, reservedDays: 2 });

      const mockQr = {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        commitTransaction: jest.fn(),
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
        manager: {
          findOne: jest.fn().mockResolvedValue(existingBalance),
          create: jest.fn().mockImplementation((_, d) => d),
          save: jest.fn().mockResolvedValue(existingBalance),
          find: jest.fn().mockResolvedValue([]),
        },
      };

      const mockSyncLogRepo = {
        create: jest.fn().mockImplementation((d) => d),
        save: jest.fn().mockResolvedValue({ id: 1 }),
        update: jest.fn().mockResolvedValue({}),
      };

      const mockBalanceService = {
        detectDiscrepancy: jest.fn().mockReturnValue(false),
      };

      const mockDataSource = {
        createQueryRunner: jest.fn().mockReturnValue(mockQr),
      };

      const service = makeSyncService({
        syncLogRepo: mockSyncLogRepo,
        balanceService: mockBalanceService,
        dataSource: mockDataSource,
      });

      const result = await service.processBatchPayload([
        { employeeId: 1, locationId: 'LOC1', leaveType: 'ANNUAL', totalDays: 10, hcmVersion: '2' },
      ]);

      expect(result.discrepancies).toBe(0);
    });

    it('returns correct recordsProcessed count', async () => {
      const mockQr = {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        commitTransaction: jest.fn(),
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
        manager: {
          findOne: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockImplementation((_, d) => d),
          save: jest.fn().mockImplementation((_, d) => Promise.resolve(d)),
          find: jest.fn().mockResolvedValue([]),
        },
      };

      const mockSyncLogRepo = {
        create: jest.fn().mockImplementation((d) => d),
        save: jest.fn().mockResolvedValue({ id: 1 }),
        update: jest.fn().mockResolvedValue({}),
      };

      const mockDataSource = {
        createQueryRunner: jest.fn().mockReturnValue(mockQr),
      };

      const service = makeSyncService({
        syncLogRepo: mockSyncLogRepo,
        balanceService: { detectDiscrepancy: jest.fn().mockReturnValue(false) },
        dataSource: mockDataSource,
      });

      const records: BatchRecord[] = Array.from({ length: 5 }, (_, i) => ({
        employeeId: i + 1, locationId: 'LOC1', leaveType: 'ANNUAL',
        totalDays: 10, hcmVersion: '1',
      }));

      const result = await service.processBatchPayload(records);
      expect(result.recordsProcessed).toBe(5);
    });

    it('returns correct discrepancies count', async () => {
      let call = 0;
      const mockQr = {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        commitTransaction: jest.fn(),
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
        manager: {
          findOne: jest.fn().mockImplementation(() => makeBalance({ totalDays: 10, usedDays: 8, reservedDays: 4 })),
          create: jest.fn().mockImplementation((_, d) => d),
          save: jest.fn().mockImplementation((_, d) => Promise.resolve(d)),
          find: jest.fn().mockResolvedValue([]),
        },
      };

      const mockSyncLogRepo = {
        create: jest.fn().mockImplementation((d) => d),
        save: jest.fn().mockResolvedValue({ id: 1 }),
        update: jest.fn().mockResolvedValue({}),
      };

      // 2 of 3 records cause discrepancies
      const detectMock = jest.fn()
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true);

      const mockDataSource = {
        createQueryRunner: jest.fn().mockReturnValue(mockQr),
      };

      const service = makeSyncService({
        syncLogRepo: mockSyncLogRepo,
        balanceService: { detectDiscrepancy: detectMock },
        dataSource: mockDataSource,
      });

      const records: BatchRecord[] = Array.from({ length: 3 }, (_, i) => ({
        employeeId: i + 1, locationId: 'LOC1', leaveType: 'ANNUAL', totalDays: 6, hcmVersion: '2',
      }));

      const result = await service.processBatchPayload(records);
      expect(result.discrepancies).toBe(2);
    });
  });

  describe('processWebhookPayload', () => {
    it('updates totalDays and lastSyncedAt on the matching balance record', async () => {
      const existing = makeBalance({ totalDays: 10, usedDays: 0, reservedDays: 0 });
      let savedBalance: unknown = null;

      const mockBalanceRepo = {
        findOne: jest.fn().mockResolvedValue(existing),
        save: jest.fn().mockImplementation((b) => { savedBalance = b; return Promise.resolve(b); }),
      };

      const mockSyncLogRepo = {
        create: jest.fn().mockImplementation((d) => d),
        save: jest.fn().mockResolvedValue({ id: 2 }),
      };

      const mockBalanceService = {
        detectDiscrepancy: jest.fn().mockReturnValue(false),
      };

      const service = makeSyncService({
        balanceRepo: mockBalanceRepo,
        syncLogRepo: mockSyncLogRepo,
        balanceService: mockBalanceService,
        dataSource: { createQueryRunner: jest.fn() },
      });

      await service.processWebhookPayload({
        employeeId: 1, locationId: 'LOC1', leaveType: 'ANNUAL', totalDays: 15, hcmVersion: '2',
      });

      expect(mockBalanceRepo.save).toHaveBeenCalledTimes(1);
      expect((savedBalance as any).totalDays).toBe(15);
      expect((savedBalance as any).hcmVersion).toBe('2');
      expect((savedBalance as any).lastSyncedAt).toBeInstanceOf(Date);
    });

    it('flags active requests when new total is below used plus reserved', async () => {
      const existing = makeBalance({ totalDays: 10, usedDays: 5, reservedDays: 4 });

      const mockBalanceRepo = {
        findOne: jest.fn().mockResolvedValue(existing),
        save: jest.fn().mockResolvedValue(existing),
      };

      const mockSyncLogRepo = {
        create: jest.fn().mockImplementation((d) => d),
        save: jest.fn().mockResolvedValue({ id: 2 }),
      };

      const mockBalanceService = {
        detectDiscrepancy: jest.fn().mockReturnValue(true),
      };

      const mockQr = {
        connect: jest.fn(),
        release: jest.fn(),
        manager: { find: jest.fn().mockResolvedValue([{ id: 1 }]) },
      };

      const service = makeSyncService({
        balanceRepo: mockBalanceRepo,
        syncLogRepo: mockSyncLogRepo,
        balanceService: mockBalanceService,
        dataSource: { createQueryRunner: jest.fn().mockReturnValue(mockQr) },
      });

      await service.processWebhookPayload({
        employeeId: 1, locationId: 'LOC1', leaveType: 'ANNUAL', totalDays: 6, hcmVersion: '2',
      });

      expect(mockBalanceService.detectDiscrepancy).toHaveReturnedWith(true);
      expect(mockQr.manager.find).toHaveBeenCalledTimes(1);
    });

    it('does nothing if no matching balance record exists (idempotent)', async () => {
      const mockBalanceRepo = {
        findOne: jest.fn().mockResolvedValue(null),
        save: jest.fn(),
      };

      const service = makeSyncService({ balanceRepo: mockBalanceRepo });

      await expect(
        service.processWebhookPayload({
          employeeId: 999, locationId: 'LOC1', leaveType: 'ANNUAL', totalDays: 10, hcmVersion: '1',
        }),
      ).rejects.toThrow(NotFoundException);

      expect(mockBalanceRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('processBatchPayload error path', () => {
    it('logs non-Error thrown values as string in sync log error detail', async () => {
      const mockQr = {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        commitTransaction: jest.fn(),
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
        manager: {
          findOne: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockImplementation((_, d) => d),
          // Throw a plain string (not an Error) to exercise the String(err) branch
          save: jest.fn().mockRejectedValue('plain string error'),
          find: jest.fn().mockResolvedValue([]),
        },
      };

      const mockSyncLogRepo = {
        create: jest.fn().mockImplementation((d) => d),
        save: jest.fn().mockResolvedValue({ id: 98 }),
        update: jest.fn().mockResolvedValue({}),
      };

      const mockDataSource = {
        createQueryRunner: jest.fn().mockReturnValue(mockQr),
      };

      const service = makeSyncService({
        syncLogRepo: mockSyncLogRepo,
        balanceService: { detectDiscrepancy: jest.fn().mockReturnValue(false) },
        dataSource: mockDataSource,
      });

      await expect(
        service.processBatchPayload([
          { employeeId: 1, locationId: 'LOC1', leaveType: 'ANNUAL', totalDays: 10, hcmVersion: '1' },
        ]),
      ).rejects.toBe('plain string error');

      expect(mockSyncLogRepo.update).toHaveBeenCalledWith(
        98,
        expect.objectContaining({ errorDetail: 'plain string error' }),
      );
    });

    it('rolls back and rethrows when a save fails mid-batch', async () => {
      const mockQr = {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        commitTransaction: jest.fn(),
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
        manager: {
          findOne: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockImplementation((_, d) => d),
          save: jest.fn().mockRejectedValue(new Error('DB constraint')),
          find: jest.fn().mockResolvedValue([]),
        },
      };

      const mockSyncLogRepo = {
        create: jest.fn().mockImplementation((d) => d),
        save: jest.fn().mockResolvedValue({ id: 99 }),
        update: jest.fn().mockResolvedValue({}),
      };

      const mockDataSource = {
        createQueryRunner: jest.fn().mockReturnValue(mockQr),
      };

      const service = makeSyncService({
        syncLogRepo: mockSyncLogRepo,
        balanceService: { detectDiscrepancy: jest.fn().mockReturnValue(false) },
        dataSource: mockDataSource,
      });

      await expect(
        service.processBatchPayload([
          { employeeId: 1, locationId: 'LOC1', leaveType: 'ANNUAL', totalDays: 10, hcmVersion: '1' },
        ]),
      ).rejects.toThrow('DB constraint');

      expect(mockQr.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(mockSyncLogRepo.update).toHaveBeenCalledWith(
        99,
        expect.objectContaining({ status: SyncLogStatus.FAILED }),
      );
    });
  });

  describe('triggerReconciliation', () => {
    it('fetches stale balances from HCM and updates them', async () => {
      const staleBalance = makeBalance({ id: 1, lastSyncedAt: new Date(Date.now() - 40 * 60 * 1000) });

      const mockBalanceRepo = {
        find: jest.fn()
          .mockResolvedValueOnce([staleBalance]) // stale balances query
          .mockResolvedValueOnce([]), // active employee balances (none)
        save: jest.fn().mockImplementation((b) => Promise.resolve(b)),
      };

      const mockRequestRepo = {
        find: jest.fn().mockResolvedValue([]), // no active requests
      };

      const mockSyncLogRepo = {
        create: jest.fn().mockImplementation((d) => d),
        save: jest.fn().mockResolvedValue({ id: 10 }),
        update: jest.fn().mockResolvedValue({}),
      };

      const mockHcmClient = {
        getBalance: jest.fn().mockResolvedValue({ totalDays: 15, hcmVersion: '3' }),
      };

      const mockBalanceService = {
        detectDiscrepancy: jest.fn().mockReturnValue(false),
      };

      const service = makeSyncService({
        balanceRepo: mockBalanceRepo,
        requestRepo: mockRequestRepo,
        syncLogRepo: mockSyncLogRepo,
        hcmClient: mockHcmClient,
        balanceService: mockBalanceService,
      });

      const result = await service.triggerReconciliation();

      expect(result.recordsProcessed).toBe(1);
      expect(mockHcmClient.getBalance).toHaveBeenCalledTimes(1);
      expect(mockBalanceRepo.save).toHaveBeenCalledTimes(1);
    });

    it('returns 0 recordsProcessed when no stale balances exist', async () => {
      const mockBalanceRepo = {
        find: jest.fn().mockResolvedValue([]), // no stale balances
      };

      const mockRequestRepo = {
        find: jest.fn().mockResolvedValue([]), // no active requests
      };

      const mockSyncLogRepo = {
        create: jest.fn().mockImplementation((d) => d),
        save: jest.fn().mockResolvedValue({ id: 11 }),
        update: jest.fn().mockResolvedValue({}),
      };

      const service = makeSyncService({
        balanceRepo: mockBalanceRepo,
        requestRepo: mockRequestRepo,
        syncLogRepo: mockSyncLogRepo,
      });

      const result = await service.triggerReconciliation();

      expect(result.recordsProcessed).toBe(0);
    });

    it('includes balances for employees with active requests even if not stale', async () => {
      const activeBalance = makeBalance({ id: 2, employeeId: 5 });

      const mockBalanceRepo = {
        find: jest.fn()
          .mockResolvedValueOnce([]) // no stale balances
          .mockResolvedValueOnce([activeBalance]), // balance for active employee
        save: jest.fn().mockImplementation((b) => Promise.resolve(b)),
      };

      const mockRequestRepo = {
        find: jest.fn().mockResolvedValue([
          { id: 100, employeeId: 5, status: RequestStatus.PENDING },
        ]),
      };

      const mockSyncLogRepo = {
        create: jest.fn().mockImplementation((d) => d),
        save: jest.fn().mockResolvedValue({ id: 12 }),
        update: jest.fn().mockResolvedValue({}),
      };

      const mockHcmClient = {
        getBalance: jest.fn().mockResolvedValue({ totalDays: 10, hcmVersion: '1' }),
      };

      const mockBalanceService = {
        detectDiscrepancy: jest.fn().mockReturnValue(false),
      };

      const service = makeSyncService({
        balanceRepo: mockBalanceRepo,
        requestRepo: mockRequestRepo,
        syncLogRepo: mockSyncLogRepo,
        hcmClient: mockHcmClient,
        balanceService: mockBalanceService,
      });

      const result = await service.triggerReconciliation();

      expect(result.recordsProcessed).toBe(1);
    });

    it('counts discrepancies when HCM total is below used plus reserved', async () => {
      const staleBalance = makeBalance({ id: 3, usedDays: 5, reservedDays: 4 });

      const mockBalanceRepo = {
        find: jest.fn()
          .mockResolvedValueOnce([staleBalance])
          .mockResolvedValueOnce([]),
        save: jest.fn().mockImplementation((b) => Promise.resolve(b)),
      };

      const mockRequestRepo = { find: jest.fn().mockResolvedValue([]) };

      const mockSyncLogRepo = {
        create: jest.fn().mockImplementation((d) => d),
        save: jest.fn().mockResolvedValue({ id: 13 }),
        update: jest.fn().mockResolvedValue({}),
      };

      const mockHcmClient = {
        getBalance: jest.fn().mockResolvedValue({ totalDays: 6, hcmVersion: '2' }),
      };

      const mockBalanceService = {
        detectDiscrepancy: jest.fn().mockReturnValue(true),
      };

      const service = makeSyncService({
        balanceRepo: mockBalanceRepo,
        requestRepo: mockRequestRepo,
        syncLogRepo: mockSyncLogRepo,
        hcmClient: mockHcmClient,
        balanceService: mockBalanceService,
      });

      await service.triggerReconciliation();

      expect(mockSyncLogRepo.update).toHaveBeenCalledWith(
        13,
        expect.objectContaining({ discrepancies: 1 }),
      );
    });

    it('continues processing remaining balances when one HCM fetch fails', async () => {
      const balance1 = makeBalance({ id: 4, employeeId: 1 });
      const balance2 = makeBalance({ id: 5, employeeId: 2 });

      const mockBalanceRepo = {
        find: jest.fn()
          .mockResolvedValueOnce([balance1, balance2])
          .mockResolvedValueOnce([]),
        save: jest.fn().mockImplementation((b) => Promise.resolve(b)),
      };

      const mockRequestRepo = { find: jest.fn().mockResolvedValue([]) };

      const mockSyncLogRepo = {
        create: jest.fn().mockImplementation((d) => d),
        save: jest.fn().mockResolvedValue({ id: 14 }),
        update: jest.fn().mockResolvedValue({}),
      };

      const mockHcmClient = {
        getBalance: jest.fn()
          .mockRejectedValueOnce(new Error('HCM timeout')) // balance1 fails
          .mockResolvedValueOnce({ totalDays: 10, hcmVersion: '1' }), // balance2 succeeds
      };

      const mockBalanceService = {
        detectDiscrepancy: jest.fn().mockReturnValue(false),
      };

      const service = makeSyncService({
        balanceRepo: mockBalanceRepo,
        requestRepo: mockRequestRepo,
        syncLogRepo: mockSyncLogRepo,
        hcmClient: mockHcmClient,
        balanceService: mockBalanceService,
      });

      const result = await service.triggerReconciliation();

      // Only balance2 succeeded; balance1 error was swallowed
      expect(result.recordsProcessed).toBe(1);
    });
  });

  describe('getSyncStatus', () => {
    it('returns correct sync status shape with all fields', async () => {
      const lastBatch = { id: 1, syncType: 'BATCH', status: 'DONE', completedAt: new Date('2026-04-24T10:00:00Z') };
      const lastWebhook = { id: 2, syncType: 'WEBHOOK', status: 'DONE', completedAt: new Date('2026-04-24T09:00:00Z') };

      const mockSyncLogRepo = {
        findOne: jest.fn()
          .mockResolvedValueOnce(lastBatch)
          .mockResolvedValueOnce(lastWebhook),
      };

      const mockOutboxRepo = {
        count: jest.fn().mockResolvedValue(2),
      };

      const service = makeSyncService({
        syncLogRepo: mockSyncLogRepo,
        outboxRepo: mockOutboxRepo,
      });

      const status = await service.getSyncStatus();

      expect(status.lastBatchSyncAt).toEqual(lastBatch.completedAt);
      expect(status.lastWebhookAt).toEqual(lastWebhook.completedAt);
      expect(status.outboxQueueDepth).toBeDefined();
      expect(typeof status.failedEvents).toBe('number');
    });

    it('returns null timestamps when no sync logs exist', async () => {
      const mockSyncLogRepo = {
        findOne: jest.fn().mockResolvedValue(null),
      };

      const mockOutboxRepo = {
        count: jest.fn().mockResolvedValue(0),
      };

      const service = makeSyncService({
        syncLogRepo: mockSyncLogRepo,
        outboxRepo: mockOutboxRepo,
      });

      const status = await service.getSyncStatus();

      expect(status.lastBatchSyncAt).toBeNull();
      expect(status.lastWebhookAt).toBeNull();
    });

    it('defaults failedEvents to 0 when FAILED count is not in depthByStatus', async () => {
      const mockSyncLogRepo = {
        findOne: jest.fn().mockResolvedValue(null),
      };

      // count returns undefined to exercise the ?? 0 fallback
      const mockOutboxRepo = {
        count: jest.fn().mockResolvedValue(undefined),
      };

      const service = makeSyncService({
        syncLogRepo: mockSyncLogRepo,
        outboxRepo: mockOutboxRepo,
      });

      const status = await service.getSyncStatus();

      expect(status.failedEvents).toBe(0);
    });
  });
});
