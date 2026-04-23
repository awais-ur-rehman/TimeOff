import * as request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { setupTestApp, teardownTestApp, resetState } from './helpers/db.helper';

describe('Outbox idempotency', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await setupTestApp();
  });

  afterAll(async () => {
    await teardownTestApp(app);
  });

  beforeEach(async () => {
    await resetState(app);
  });

  it('sending the same HCM deduction request twice with the same idempotency key does not double-deduct', async () => {
    // Manually insert two outbox events with the same request_id
    // Let processor run both
    // Assert HCM balance was only deducted once
  });
});

describe('Outbox retry backoff', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await setupTestApp();
  });

  afterAll(async () => {
    await teardownTestApp(app);
  });

  beforeEach(async () => {
    await resetState(app);
  });

  it('failed event nextRetryAt follows the backoff schedule', async () => {
    // Set HCM_ERROR_RATE=1.0 for this test
    // Submit and approve a request
    // After first failure: assert nextRetryAt is ~30s from now
    // After second failure: assert nextRetryAt is ~300s from now
  });
});

describe('Manual retry via admin', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await setupTestApp();
  });

  afterAll(async () => {
    await teardownTestApp(app);
  });

  beforeEach(async () => {
    await resetState(app);
  });

  it('POST /outbox/:id/retry resets a FAILED event to PENDING with nextRetryAt = now', () => {});
  it('returns 404 when outbox event does not exist', () => {});
  it('returns 400 when event is not in FAILED state', () => {});
});
