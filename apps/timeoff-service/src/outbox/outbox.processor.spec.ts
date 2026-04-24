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

function makeQr(overrides: Record<string, unknown> = {}) {
  return {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: {
      update: jest.fn().mockResolvedValue({}),
      ...(overrides.manager as Record<string, unknown> ?? {}),
    },
    ...overrides,
  };
}

function makeProcessor(overrides: {
  outboxRepo?: Record<string, unknown>;
  hcmClient?: Record<string, unknown>;
  dataSource?: Record<string, unknown>;
  configService?: Record<string, unknown>;
  requestService?: Record<string, unknown>;
} = {}): OutboxProcessor {
  return new OutboxProcessor(
    (overrides.outboxRepo ?? {
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    }) as any,
    (overrides.hcmClient ?? {}) as any,
    (overrides.dataSource ?? {}) as any,
    (overrides.configService ?? {
      get: jest.fn().mockImplementation((_key: string, defaultVal: unknown) => defaultVal),
    }) as any,
    (overrides.requestService ?? {
      completeDeductionFromOutbox: jest.fn().mockResolvedValue({}),
      failRequestFromOutbox: jest.fn().mockResolvedValue({}),
    }) as any,
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
      const configService = {
        get: jest.fn().mockImplementation((_key: string, defaultVal: unknown) => {
          if (_key === 'HCM_MAX_RETRIES') return 2;
          return defaultVal;
        }),
      };
      const p = makeProcessor({ configService });
      expect(p.shouldMarkFailed(2)).toBe(true);
      expect(p.shouldMarkFailed(1)).toBe(false);
    });
  });

  describe('tick', () => {
    it('does nothing when no pending events exist', async () => {
      const outboxRepo = {
        find: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
      };
      const processor = makeProcessor({ outboxRepo });

      await processor.tick();

      // update should not be called because there are no events to claim
      expect(outboxRepo.update).not.toHaveBeenCalled();
    });

    it('claims each event by updating status from PENDING to PROCESSING', async () => {
      const event = makeEvent();
      const outboxRepo = {
        find: jest.fn().mockResolvedValue([event]),
        update: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      const hcmClient = { deductBalance: jest.fn().mockResolvedValue('hcm-123') };
      const requestService = {
        completeDeductionFromOutbox: jest.fn().mockResolvedValue({}),
        failRequestFromOutbox: jest.fn().mockResolvedValue({}),
      };
      const mockQr = makeQr();
      const dataSource = { createQueryRunner: jest.fn().mockReturnValue(mockQr) };

      const processor = makeProcessor({ outboxRepo, hcmClient, dataSource, requestService });
      await processor.tick();

      expect(outboxRepo.update).toHaveBeenCalledWith(
        { id: event.id, status: OutboxEventStatus.PENDING },
        { status: OutboxEventStatus.PROCESSING },
      );
    });

    it('skips event if claim fails (another worker claimed it)', async () => {
      const event = makeEvent();
      const outboxRepo = {
        find: jest.fn().mockResolvedValue([event]),
        update: jest.fn().mockResolvedValue({ affected: 0 }),
      };
      const hcmClient = { deductBalance: jest.fn() };
      const processor = makeProcessor({ outboxRepo, hcmClient });

      await processor.tick();

      expect(hcmClient.deductBalance).not.toHaveBeenCalled();
    });

    it('processes a deduct event end-to-end: HCM call → transition → outbox DONE', async () => {
      const event = makeEvent();
      const outboxRepo = {
        find: jest.fn().mockResolvedValue([event]),
        update: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      const hcmClient = { deductBalance: jest.fn().mockResolvedValue('hcm-123') };
      const requestService = {
        completeDeductionFromOutbox: jest.fn().mockResolvedValue({}),
        failRequestFromOutbox: jest.fn().mockResolvedValue({}),
      };
      const mockQr = makeQr();
      const dataSource = { createQueryRunner: jest.fn().mockReturnValue(mockQr) };

      const processor = makeProcessor({ outboxRepo, hcmClient, dataSource, requestService });
      await processor.tick();

      expect(hcmClient.deductBalance).toHaveBeenCalledWith(1, 'LOC1', 'ANNUAL', 3, `outbox-${event.id}`);
      expect(requestService.completeDeductionFromOutbox).toHaveBeenCalledWith(mockQr, event.requestId, 'hcm-123');
      expect(mockQr.commitTransaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('processDeductEvent', () => {
    it('marks event DONE via qr.manager after completing deduction', async () => {
      const event = makeEvent({ id: 5, requestId: 10 });
      const outboxRepo = {
        find: jest.fn().mockResolvedValue([event]),
        update: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      const hcmClient = { deductBalance: jest.fn().mockResolvedValue('hcm-abc') };
      const requestService = {
        completeDeductionFromOutbox: jest.fn().mockResolvedValue({}),
        failRequestFromOutbox: jest.fn().mockResolvedValue({}),
      };
      const mockQr = makeQr();
      const dataSource = { createQueryRunner: jest.fn().mockReturnValue(mockQr) };

      const processor = makeProcessor({ outboxRepo, hcmClient, dataSource, requestService });
      await processor.tick();

      // The outbox event update to DONE happens through qr.manager.update inside the transaction
      expect(mockQr.manager.update).toHaveBeenCalled();
      expect(mockQr.commitTransaction).toHaveBeenCalledTimes(1);
    });

    it('rolls back and resets to PENDING on DB error after HCM success', async () => {
      const event = makeEvent({ id: 7, requestId: 12 });
      const dbError = new Error('DB write failed');

      const outboxRepo = {
        find: jest.fn().mockResolvedValue([event]),
        update: jest.fn()
          .mockResolvedValueOnce({ affected: 1 })  // claim succeeds
          .mockResolvedValueOnce({}),               // reset to PENDING after failure
      };
      const hcmClient = { deductBalance: jest.fn().mockResolvedValue('hcm-def') };
      const requestService = {
        completeDeductionFromOutbox: jest.fn().mockRejectedValue(dbError),
        failRequestFromOutbox: jest.fn().mockResolvedValue({}),
      };
      const mockQr = makeQr();
      const dataSource = { createQueryRunner: jest.fn().mockReturnValue(mockQr) };

      const processor = makeProcessor({ outboxRepo, hcmClient, dataSource, requestService });
      await processor.tick();

      expect(mockQr.rollbackTransaction).toHaveBeenCalledTimes(1);
      // outboxRepo.update is called to reset to PENDING with nextRetryAt = now
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
        update: jest.fn().mockResolvedValue({ affected: 1 }),
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
        update: jest.fn().mockResolvedValue({ affected: 1 }),
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
    it('marks event FAILED and calls failRequestFromOutbox when max retries exceeded', async () => {
      const event = makeEvent({ id: 11, requestId: 30, attempts: 3 });
      const outboxRepo = {
        find: jest.fn().mockResolvedValue([event]),
        update: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      const hcmClient = { deductBalance: jest.fn().mockRejectedValue(new Error('HCM down')) };
      const configService = {
        get: jest.fn().mockImplementation((_key: string, defaultVal: unknown) => {
          if (_key === 'HCM_MAX_RETRIES') return 4;
          return defaultVal;
        }),
      };
      const requestService = {
        completeDeductionFromOutbox: jest.fn(),
        failRequestFromOutbox: jest.fn().mockResolvedValue({}),
      };
      const mockQr = makeQr();
      const dataSource = { createQueryRunner: jest.fn().mockReturnValue(mockQr) };

      const processor = makeProcessor({ outboxRepo, hcmClient, dataSource, configService, requestService });
      await processor.tick();

      // attempts goes from 3 → 4, which equals maxRetries (4) → FAILED
      // The FAILED path creates its own queryRunner and uses qr.manager.update for the outbox event
      expect(requestService.failRequestFromOutbox).toHaveBeenCalled();
    });

    it('resets event to PENDING with bumped attempts and backoff when retries remain', async () => {
      const event = makeEvent({ id: 12, requestId: 31, attempts: 0 });
      const outboxRepo = {
        find: jest.fn().mockResolvedValue([event]),
        update: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      const hcmClient = { deductBalance: jest.fn().mockRejectedValue(new Error('transient')) };
      const configService = {
        get: jest.fn().mockImplementation((_key: string, defaultVal: unknown) => {
          if (_key === 'HCM_MAX_RETRIES') return 4;
          return defaultVal;
        }),
      };
      const requestService = {
        completeDeductionFromOutbox: jest.fn(),
        failRequestFromOutbox: jest.fn(),
      };
      const dataSource = { createQueryRunner: jest.fn() };

      const processor = makeProcessor({ outboxRepo, hcmClient, dataSource, configService, requestService });
      await processor.tick();

      // attempts goes from 0 → 1, not yet at maxRetries → stays PENDING
      // outboxRepo.update is called: first for claim, then for the retry reset
      const updateCalls = outboxRepo.update.mock.calls;
      const retryCalls = updateCalls.filter(
        (call: [unknown, Record<string, unknown>]) =>
          typeof call[0] === 'number' && call[1].status === OutboxEventStatus.PENDING && call[1].attempts === 1,
      );
      expect(retryCalls.length).toBe(1);
      expect(retryCalls[0][1].nextRetryAt).toBeInstanceOf(Date);
    });
  });
});
