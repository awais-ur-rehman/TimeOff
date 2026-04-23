import * as request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { setupTestApp, teardownTestApp, resetState } from './helpers/db.helper';

describe('GET /balances/:employeeId', () => {
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

  it('returns all balance records for an employee with effective_available calculated', () => {});
  it('returns 403 when caller is a different employee', () => {});
  it('returns 200 when caller is a manager', () => {});
  it('returns 404 when employee does not exist', () => {});
});

describe('GET /balances/:employeeId/:locationId', () => {
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

  it('returns balance for specific location only', () => {});
  it('returns 404 when no balance exists for that location', () => {});
});
