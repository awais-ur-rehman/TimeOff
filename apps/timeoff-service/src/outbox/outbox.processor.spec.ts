import { OutboxProcessor } from './outbox.processor';
import { OutboxEvent, OutboxEventStatus } from './outbox.entity';
import { OutboxEventType } from '../common/enums/outbox-event-type.enum';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<OutboxEvent> = {}): OutboxEvent {
  return {
    id: 1,
    eventType: OutboxEventType.HCM_DEDUCT,
    payload: JSON.stringify({ employeeId: 1, locationId: 'LOC1', leaveType: 'ANNUAL', days: 3 }),
    status: OutboxEventStatus.PENDING,
    attempts: 0,
    nextRetryAt: null,
    requestId: 10,
    createdAt: new Date(),
    ...overrides,
  } as OutboxEvent;
}

function makeProcessor(overrides: {
  outboxRepo?: unknown;
  hcmClient?: unknown;
  dataSource?: unknown;
  configService?: unknown;
} = {}): OutboxProcessor {
  return new OutboxProcessor(
    (overrides.outboxRepo ?? null) as any,
    (overrides.hcmClient ?? null) as any,
    (overrides.dataSource ?? null) as any,
    (overrides.configService ?? null) as any,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('OutboxProcessor', () => {
  describe('calculateNextRetryAt', () => {
    let processor: OutboxProcessor;
    beforeEach(() => { processor = makeProcessor(); });

    it('returns 0 seconds delay on first attempt', () => {
      const before = new Date();
      const result = processor.calculateNextRetryAt(0);
      const after = new Date();
      expect(result.getTime()).toBeGreaterThanOrEqual(before.getTime() - 50);
      expect(result.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
    });

    it('returns 30 seconds delay on second attempt', () => {
      const before = Date.now();
      const result = processor.calculateNextRetryAt(1);
      const diff = result.getTime() - before;
      expect(diff).toBeGreaterThanOrEqual(29_000);
      expect(diff).toBeLessThanOrEqual(31_000);
    });

    it('returns 300 seconds delay on third attempt', () => {
      const before = Date.now();
      const result = processor.calculateNextRetryAt(2);
      const diff = result.getTime() - before;
      expect(diff).toBeGreaterThanOrEqual(299_000);
      expect(diff).toBeLessThanOrEqual(301_000);
    });

    it('returns 1800 seconds delay on fourth attempt', () => {
      const before = Date.now();
      const result = processor.calculateNextRetryAt(3);
      const diff = result.getTime() - before;
      expect(diff).toBeGreaterThanOrEqual(1_799_000);
      expect(diff).toBeLessThanOrEqual(1_801_000);
    });

    it('clamps to max backoff for out-of-range attempt index', () => {
      const before = Date.now();
      const result = processor.calculateNextRetryAt(99);
      const diff = result.getTime() - before;
      // Should clamp to BACKOFF_SECONDS[3] = 1800s
      expect(diff).toBeGreaterThanOrEqual(1_799_000);
      expect(diff).toBeLessThanOrEqual(1_801_000);
    });
  });

  describe('shouldMarkFailed', () => {
    let processor: OutboxProcessor;
    beforeEach(() => { processor = makeProcessor(); });

    it('returns true when attempts reach HCM_MAX_RETRIES (default 4)', () => {
      expect(processor.shouldMarkFailed(4)).toBe(true);
    });

    it('returns false when attempts are below HCM_MAX_RETRIES', () => {
      expect(processor.shouldMarkFailed(3)).toBe(false);
    });

    it('uses configService value when available', () => {
      const configService = { get: jest.fn().mockReturnValue(2) };
      const p = makeProcessor({ configService });
      expect(p.shouldMarkFailed(2)).toBe(true);
      expect(p.shouldMarkFailed(1)).toBe(false);
    });
  });

  describe('tick', () => {
    it('does nothing when no pending events exist', async () => {
      const outboxRepo = {
        find: jest.fn().mockResolvedValue([]),
        createQueryBuilder: jest.fn(),
      };
      const processor = makeProcessor({ outboxRepo });

      await processor.tick();

      expect(outboxRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('processes each pending event', async () => {
      const event = makeEvent();
      const updateBuilder = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        whereInIds: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({}),
      };
      const outboxRepo = {
        find: jest.fn().mockResolvedValue([event]),
        createQueryBuilder: jest.fn().mockReturnValue(updateBuilder),
        update: jest.fn().mockResolvedValue({}),
      };

      const mockQr = {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        commitTransaction: jest.fn(),
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
        query: jest.fn()
          .mockResolvedValueOnce({}) // UPDATE hcm_request_id
          .mockResolvedValueOnce({ affected: 1 }) // UPDATE status = APPROVED
          .mockResolvedValueOnce({}) // UPDATE reserved/used days
          .mockResolvedValueOnce({}), // UPDATE outbox status = DONE
      };

      const hcmClient = {
        deductBalance: jest.fn().mockResolvedValue('hcm-123'),
      };

      const dataSource = {
        createQueryRunner: jest.fn().mockReturnValue(mockQr),
      };

      const processor = makeProcessor({ outboxRepo, hcmClient, dataSource });

      await processor.tick();

      expect(hcmClient.deductBalance).toHaveBeenCalledTimes(1);
      expect(mockQr.commitTransaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('processDeductEvent', () => {
    it('marks event DONE and moves reserved to used when request transitions to APPROVED', async () => {
      const event = makeEvent({ id: 5, requestId: 10 });

      const mockQr = {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        commitTransaction: jest.fn(),
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
        query: jest.fn()
          .mockResolvedValueOnce({}) // UPDATE hcm_request_id
          .mockResolvedValueOnce({ affected: 1 }) // UPDATE status = APPROVED
          .mockResolvedValueOnce({}) // UPDATE reserved/used days
          .mockResolvedValueOnce({}), // UPDATE outbox DONE
      };

      const outboxRepo = {
        find: jest.fn().mockResolvedValue([event]),
        createQueryBuilder: jest.fn().mockReturnValue({
          update: jest.fn().mockReturnThis(),
          set: jest.fn().mockReturnThis(),
          whereInIds: jest.fn().mockReturnThis(),
          execute: jest.fn().mockResolvedValue({}),
        }),
        update: jest.fn().mockResolvedValue({}),
      };

      const hcmClient = { deductBalance: jest.fn().mockResolvedValue('hcm-abc') };
      const dataSource = { createQueryRunner: jest.fn().mockReturnValue(mockQr) };

      const processor = makeProcessor({ outboxRepo, hcmClient, dataSource });
      await processor.tick();

      // 4 queries: hcm_request_id update, status update, balance update, outbox update
      expect(mockQr.query).toHaveBeenCalledTimes(4);
    });

    it('skips balance update when request was not in APPROVED_PENDING_HCM state', async () => {
      const event = makeEvent({ id: 6, requestId: 11 });

      const mockQr = {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        commitTransaction: jest.fn(),
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
        query: jest.fn()
          .mockResolvedValueOnce({}) // UPDATE hcm_request_id
          .mockResolvedValueOnce({ affected: 0 }) // UPDATE status = APPROVED (no match)
          .mockResolvedValueOnce({}), // UPDATE outbox DONE
      };

      const outboxRepo = {
        find: jest.fn().mockResolvedValue([event]),
        createQueryBuilder: jest.fn().mockReturnValue({
          update: jest.fn().mockReturnThis(),
          set: jest.fn().mockReturnThis(),
          whereInIds: jest.fn().mockReturnThis(),
          execute: jest.fn().mockResolvedValue({}),
        }),
        update: jest.fn().mockResolvedValue({}),
      };

      const hcmClient = { deductBalance: jest.fn().mockResolvedValue('hcm-xyz') };
      const dataSource = { createQueryRunner: jest.fn().mockReturnValue(mockQr) };

      const processor = makeProcessor({ outboxRepo, hcmClient, dataSource });
      await processor.tick();

      // Only 3 queries: no balance update since affected=0
      expect(mockQr.query).toHaveBeenCalledTimes(3);
    });

    it('rolls back and resets to PENDING on DB error after HCM success', async () => {
      const event = makeEvent({ id: 7, requestId: 12 });
      const dbError = new Error('DB write failed');

      const mockQr = {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        commitTransaction: jest.fn(),
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
        query: jest.fn()
          .mockResolvedValueOnce({}) // UPDATE hcm_request_id
          .mockRejectedValueOnce(dbError), // UPDATE status throws
      };

      const outboxRepo = {
        find: jest.fn().mockResolvedValue([event]),
        createQueryBuilder: jest.fn().mockReturnValue({
          update: jest.fn().mockReturnThis(),
          set: jest.fn().mockReturnThis(),
          whereInIds: jest.fn().mockReturnThis(),
          execute: jest.fn().mockResolvedValue({}),
        }),
        update: jest.fn().mockResolvedValue({}),
      };

      const hcmClient = { deductBalance: jest.fn().mockResolvedValue('hcm-def') };
      const dataSource = { createQueryRunner: jest.fn().mockReturnValue(mockQr) };

      const processor = makeProcessor({ outboxRepo, hcmClient, dataSource });
      await processor.tick();

      expect(mockQr.rollbackTransaction).toHaveBeenCalledTimes(1);
      // outboxRepo.update resets to PENDING
      expect(outboxRepo.update).toHaveBeenCalledWith(
        event.id,
        expect.objectContaining({ status: OutboxEventStatus.PENDING }),
      );
    });
  });

  describe('processReverseEvent', () => {
    it('calls reverseDeduction and marks event DONE', async () => {
      const event = makeEvent({
        id: 8,
        requestId: 20,
        eventType: OutboxEventType.HCM_REVERSE,
        payload: '{}',
      });

      const outboxRepo = {
        find: jest.fn().mockResolvedValue([event]),
        createQueryBuilder: jest.fn().mockReturnValue({
          update: jest.fn().mockReturnThis(),
          set: jest.fn().mockReturnThis(),
          whereInIds: jest.fn().mockReturnThis(),
          execute: jest.fn().mockResolvedValue({}),
        }),
        update: jest.fn().mockResolvedValue({}),
      };

      const hcmClient = { reverseDeduction: jest.fn().mockResolvedValue(undefined) };
      const dataSource = {
        query: jest.fn().mockResolvedValue([{ hcm_request_id: 'hcm-to-reverse' }]),
        createQueryRunner: jest.fn(),
      };

      const processor = makeProcessor({ outboxRepo, hcmClient, dataSource });
      await processor.tick();

      expect(hcmClient.reverseDeduction).toHaveBeenCalledWith('hcm-to-reverse');
      expect(outboxRepo.update).toHaveBeenCalledWith(
        event.id,
        expect.objectContaining({ status: OutboxEventStatus.DONE }),
      );
    });

    it('throws when hcm_request_id is not set on the request', async () => {
      const event = makeEvent({
        id: 9,
        requestId: 21,
        eventType: OutboxEventType.HCM_REVERSE,
        payload: '{}',
        attempts: 0,
      });

      const outboxRepo = {
        find: jest.fn().mockResolvedValue([event]),
        createQueryBuilder: jest.fn().mockReturnValue({
          update: jest.fn().mockReturnThis(),
          set: jest.fn().mockReturnThis(),
          whereInIds: jest.fn().mockReturnThis(),
          execute: jest.fn().mockResolvedValue({}),
        }),
        update: jest.fn().mockResolvedValue({}),
      };

      const hcmClient = { reverseDeduction: jest.fn() };
      const dataSource = {
        // hcm_request_id is null — not yet set
        query: jest.fn().mockResolvedValue([{ hcm_request_id: null }]),
        createQueryRunner: jest.fn(),
      };

      const processor = makeProcessor({ outboxRepo, hcmClient, dataSource });
      await processor.tick();

      // Should NOT call reverseDeduction; failure handler should bump attempts
      expect(hcmClient.reverseDeduction).not.toHaveBeenCalled();
      expect(outboxRepo.update).toHaveBeenCalledWith(
        event.id,
        expect.objectContaining({ attempts: 1 }),
      );
    });
  });

  describe('handleEventFailure', () => {
    it('marks event FAILED and request FAILED when max retries exceeded', async () => {
      const event = makeEvent({ id: 11, requestId: 30, attempts: 3 });

      const outboxRepo = {
        find: jest.fn().mockResolvedValue([event]),
        createQueryBuilder: jest.fn().mockReturnValue({
          update: jest.fn().mockReturnThis(),
          set: jest.fn().mockReturnThis(),
          whereInIds: jest.fn().mockReturnThis(),
          execute: jest.fn().mockResolvedValue({}),
        }),
        update: jest.fn().mockResolvedValue({}),
      };

      const hcmClient = { deductBalance: jest.fn().mockRejectedValue(new Error('HCM down')) };
      const dataSource = {
        createQueryRunner: jest.fn(),
        query: jest.fn().mockResolvedValue({}),
      };
      const configService = { get: jest.fn().mockReturnValue(4) };

      const processor = makeProcessor({ outboxRepo, hcmClient, dataSource, configService });
      await processor.tick();

      // attempts goes from 3 → 4, which equals maxRetries (4) → FAILED
      expect(outboxRepo.update).toHaveBeenCalledWith(
        event.id,
        expect.objectContaining({ status: OutboxEventStatus.FAILED, attempts: 4 }),
      );
      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('FAILED'),
        [event.requestId],
      );
    });

    it('resets event to PENDING with bumped attempts when retries remain', async () => {
      const event = makeEvent({ id: 12, requestId: 31, attempts: 0 });

      const outboxRepo = {
        find: jest.fn().mockResolvedValue([event]),
        createQueryBuilder: jest.fn().mockReturnValue({
          update: jest.fn().mockReturnThis(),
          set: jest.fn().mockReturnThis(),
          whereInIds: jest.fn().mockReturnThis(),
          execute: jest.fn().mockResolvedValue({}),
        }),
        update: jest.fn().mockResolvedValue({}),
      };

      const hcmClient = { deductBalance: jest.fn().mockRejectedValue(new Error('transient')) };
      const dataSource = { createQueryRunner: jest.fn(), query: jest.fn() };
      const configService = { get: jest.fn().mockReturnValue(4) };

      const processor = makeProcessor({ outboxRepo, hcmClient, dataSource, configService });
      await processor.tick();

      // attempts goes from 0 → 1, not yet at maxRetries → stays PENDING
      expect(outboxRepo.update).toHaveBeenCalledWith(
        event.id,
        expect.objectContaining({ status: OutboxEventStatus.PENDING, attempts: 1 }),
      );
    });
  });
});
