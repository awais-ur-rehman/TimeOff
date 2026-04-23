import * as request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { setupTestApp, teardownTestApp, resetState } from './helpers/db.helper';

describe('Concurrent submissions', () => {
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

  it('only one of two simultaneous requests for the same remaining balance succeeds', async () => {
    // Submit two requests for exactly the available balance in parallel (Promise.all)
    // Expect one 201 and one 422 (or one 201 and one 409)
    // Assert reserved_days equals exactly one request worth of days
  });

  it('three concurrent requests where total exceeds balance leaves exactly correct reservation', async () => {
    // Employee has 3 days. Three requests for 2 days each arrive simultaneously.
    // At most one can succeed. Assert final reserved_days <= total_days.
  });

  it('does not produce negative effective_available under concurrent load', async () => {
    // Run 10 concurrent requests of 1 day each against a balance of 5 days.
    // Wait for all to settle. Assert effective_available >= 0.
    // Assert exactly 5 requests succeeded (201) and 5 failed (422).
  });
});
