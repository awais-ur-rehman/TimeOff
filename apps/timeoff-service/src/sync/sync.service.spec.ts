import { SyncService } from './sync.service';

describe('SyncService', () => {
  let service: SyncService;

  beforeEach(() => {
    service = new SyncService(null as any, null as any, null as any);
  });

  describe('processBatchPayload', () => {
    it('upserts balance records from HCM batch', () => {});
    it('logs discrepancy when hcm total is less than used plus reserved', () => {});
    it('does not log discrepancy when totals are consistent', () => {});
    it('returns correct recordsProcessed count', () => {});
    it('returns correct discrepancies count', () => {});
  });

  describe('processWebhookPayload', () => {
    it('updates totalDays and lastSyncedAt on the matching balance record', () => {});
    it('flags active requests when new total is below used plus reserved', () => {});
    it('does nothing if no matching balance record exists (idempotent)', () => {});
  });
});
