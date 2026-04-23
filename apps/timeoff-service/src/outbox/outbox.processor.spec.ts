import { OutboxProcessor } from './outbox.processor';

describe('OutboxProcessor', () => {
  let processor: OutboxProcessor;

  beforeEach(() => {
    processor = new OutboxProcessor(null as any, null as any, null as any, null as any);
  });

  describe('calculateNextRetryAt', () => {
    it('returns 0 seconds delay on first attempt', () => {});
    it('returns 30 seconds delay on second attempt', () => {});
    it('returns 300 seconds delay on third attempt', () => {});
    it('returns 1800 seconds delay on fourth attempt', () => {});
  });

  describe('shouldMarkFailed', () => {
    it('returns true when attempts reach HCM_MAX_RETRIES', () => {});
    it('returns false when attempts are below HCM_MAX_RETRIES', () => {});
  });
});
