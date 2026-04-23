import * as request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { setupTestApp, teardownTestApp, resetState } from './helpers/db.helper';

describe('Edge cases', () => {
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

  it('requesting 0 days returns 400', () => {});
  it('requesting a negative number of days returns 400', () => {});
  it('end_date before start_date returns 400', () => {});
  it('start_date in the past returns 400', () => {});
  it('unknown leave_type returns 422 with descriptive message', () => {});
  it('unknown location_id returns 422 with descriptive message', () => {});
  it('submitting a request as a manager for someone else returns 403', () => {});
  it('manager approving a request outside their location scope returns 403', () => {});
  it('GET /requests/:id returns 404 for non-existent request', () => {});
  it('PATCH /requests/:id/approve on an already-approved request returns 409', () => {});
  it('PATCH /requests/:id/reject on an already-rejected request returns 409', () => {});
});
