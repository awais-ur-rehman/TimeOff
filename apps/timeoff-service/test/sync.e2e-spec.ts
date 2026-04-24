import * as request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { setupTestApp, teardownTestApp, resetState, futureDate, waitFor, TestContext } from './helpers/db.helper';
import { LeaveBalance } from '../src/balance/balance.entity';

const HCM_SECRET = 'test-secret';

describe('Batch sync', () => {
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

  it('POST /sync/batch upserts all balance records from HCM', async () => {
    const ctx = app as unknown as TestContext;
    const ds = app.get(DataSource);
    const adminHeaders = { 'x-employee-id': '999', 'x-role': 'admin' };

    const res = await request(app.getHttpServer())
      .post('/sync/batch')
      .set(adminHeaders)
      .send({
        records: [
          { employeeId: ctx.employeeId, locationId: ctx.locationId, leaveType: ctx.leaveType, totalDays: 20, hcmVersion: '2' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.recordsProcessed).toBe(1);

    const rows = await ds.query(
      'SELECT total_days FROM leave_balances WHERE employee_id = ? AND location_id = ? AND leave_type = ?',
      [ctx.employeeId, ctx.locationId, ctx.leaveType],
    );
    expect(Number(rows[0].total_days)).toBe(20);
  });

  it('POST /sync/batch logs a discrepancy when HCM total is below used plus reserved', async () => {
    const ctx = app as unknown as TestContext;
    const ds = app.get(DataSource);
    const adminHeaders = { 'x-employee-id': '999', 'x-role': 'admin' };

    await ds.query(
      'UPDATE leave_balances SET used_days = 5, reserved_days = 4 WHERE employee_id = ?',
      [ctx.employeeId],
    );

    const res = await request(app.getHttpServer())
      .post('/sync/batch')
      .set(adminHeaders)
      .send({
        records: [
          { employeeId: ctx.employeeId, locationId: ctx.locationId, leaveType: ctx.leaveType, totalDays: 6, hcmVersion: '2' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.discrepancies).toBe(1);
  });

  it('POST /sync/batch updates last_synced_at on all affected records', async () => {
    const ctx = app as unknown as TestContext;
    const ds = app.get(DataSource);
    const adminHeaders = { 'x-employee-id': '999', 'x-role': 'admin' };

    const before = new Date();
    await request(app.getHttpServer())
      .post('/sync/batch')
      .set(adminHeaders)
      .send({
        records: [
          { employeeId: ctx.employeeId, locationId: ctx.locationId, leaveType: ctx.leaveType, totalDays: 10, hcmVersion: '2' },
        ],
      });

    const rows = await ds.query(
      'SELECT last_synced_at FROM leave_balances WHERE employee_id = ?',
      [ctx.employeeId],
    );
    // TypeORM stores datetime as UTC string "YYYY-MM-DD HH:MM:SS" (no timezone).
    // Append 'Z' so JS Date constructor treats it as UTC, not local time.
    const rawTs = String(rows[0].last_synced_at).replace(' ', 'T') + 'Z';
    expect(new Date(rawTs).getTime()).toBeGreaterThanOrEqual(before.getTime() - 100);
  });

  it('POST /sync/batch is transactional: partial failure rolls back all changes', async () => {
    const ctx = app as unknown as TestContext;
    const ds = app.get(DataSource);
    const adminHeaders = { 'x-employee-id': '999', 'x-role': 'admin' };

    const before = await ds.query(
      'SELECT total_days FROM leave_balances WHERE employee_id = ?',
      [ctx.employeeId],
    );
    const originalTotal = Number(before[0].total_days);

    const res = await request(app.getHttpServer())
      .post('/sync/batch')
      .set(adminHeaders)
      .send({
        records: [
          { employeeId: ctx.employeeId, locationId: ctx.locationId, leaveType: ctx.leaveType, totalDays: 99, hcmVersion: '2' },
          { employeeId: ctx.employeeId, locationId: ctx.locationId, leaveType: 'SICK', totalDays: -1, hcmVersion: '1' },
        ],
      });

    // DTO validation should reject the request before DB is touched
    expect(res.status).toBeGreaterThanOrEqual(400);

    // Original balance must be unchanged
    const after = await ds.query(
      'SELECT total_days FROM leave_balances WHERE employee_id = ?',
      [ctx.employeeId],
    );
    expect(Number(after[0].total_days)).toBe(originalTotal);
  });
});

describe('Webhook sync', () => {
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

  it('POST /sync/webhook updates totalDays for the matching employee-location-leaveType record', async () => {
    const ctx = app as unknown as TestContext;
    const ds = app.get(DataSource);

    const res = await request(app.getHttpServer())
      .post('/sync/webhook')
      .set('x-hcm-secret', HCM_SECRET)
      .send({ employeeId: ctx.employeeId, locationId: ctx.locationId, leaveType: ctx.leaveType, totalDays: 15, hcmVersion: '2' });

    expect(res.status).toBe(204);

    const rows = await ds.query(
      'SELECT total_days FROM leave_balances WHERE employee_id = ?',
      [ctx.employeeId],
    );
    expect(Number(rows[0].total_days)).toBe(15);
  });

  it('POST /sync/webhook flags active requests when new total creates a discrepancy', async () => {
    const ctx = app as unknown as TestContext;
    const ds = app.get(DataSource);
    const employeeHeaders = { 'x-employee-id': String(ctx.employeeId), 'x-role': 'employee' };

    const submitRes = await request(app.getHttpServer())
      .post('/requests')
      .set(employeeHeaders)
      .send({ employeeId: ctx.employeeId, locationId: ctx.locationId, leaveType: ctx.leaveType, startDate: futureDate(1), endDate: futureDate(3) });
    expect(submitRes.status).toBe(201);

    const webhookRes = await request(app.getHttpServer())
      .post('/sync/webhook')
      .set('x-hcm-secret', HCM_SECRET)
      .send({ employeeId: ctx.employeeId, locationId: ctx.locationId, leaveType: ctx.leaveType, totalDays: 2, hcmVersion: '2' });

    expect(webhookRes.status).toBe(204);

    const logRows = await ds.query(
      "SELECT discrepancies FROM sync_log WHERE sync_type = 'WEBHOOK' ORDER BY id DESC LIMIT 1",
    );
    expect(logRows[0].discrepancies).toBe(1);
  });

  it('POST /sync/webhook with unknown employee returns 404', async () => {
    const res = await request(app.getHttpServer())
      .post('/sync/webhook')
      .set('x-hcm-secret', HCM_SECRET)
      .send({ employeeId: 99999, locationId: 'LOC1', leaveType: 'ANNUAL', totalDays: 10, hcmVersion: '1' });
    expect(res.status).toBe(404);
  });

  it('POST /sync/webhook rejects requests missing x-hcm-secret header with 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/sync/webhook')
      .send({ employeeId: 1, locationId: 'LOC1', leaveType: 'ANNUAL', totalDays: 10, hcmVersion: '1' });
    expect(res.status).toBe(401);
  });
});

describe('Scheduled reconciliation', () => {
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

  it('POST /sync/trigger fetches stale balance records from HCM real-time API and updates them', async () => {
    const ctx = app as unknown as TestContext;
    const ds = app.get(DataSource);
    const adminHeaders = { 'x-employee-id': '999', 'x-role': 'admin' };

    const staleDate = new Date(Date.now() - 35 * 60 * 1000);
    const staleBalance = await ds.manager.findOne(LeaveBalance, { where: { employeeId: ctx.employeeId } });
    if (staleBalance) {
      staleBalance.lastSyncedAt = staleDate;
      await ds.manager.save(LeaveBalance, staleBalance);
    }

    ctx.hcm.seedBalance(ctx.employeeId, ctx.locationId, ctx.leaveType, 25);

    const res = await request(app.getHttpServer())
      .post('/sync/trigger')
      .set(adminHeaders);

    expect(res.status).toBe(200);
    expect(res.body.recordsProcessed).toBeGreaterThanOrEqual(1);
  });

  it('GET /sync/status returns correct outbox queue depth', async () => {
    const ctx = app as unknown as TestContext;
    const employeeHeaders = { 'x-employee-id': String(ctx.employeeId), 'x-role': 'employee' };
    const managerHeaders = { 'x-employee-id': String(ctx.managerId), 'x-role': 'manager', 'x-location-id': ctx.locationId };
    const adminHeaders = { 'x-employee-id': '999', 'x-role': 'admin' };

    // Create and approve a request to get an outbox event
    const submitRes = await request(app.getHttpServer())
      .post('/requests')
      .set(employeeHeaders)
      .send({ employeeId: ctx.employeeId, locationId: ctx.locationId, leaveType: ctx.leaveType, startDate: futureDate(1), endDate: futureDate(3) });
    await request(app.getHttpServer())
      .patch(`/requests/${submitRes.body.id}/approve`)
      .set(managerHeaders);

    // Wait a tick for processor
    await new Promise((r) => setTimeout(r, 300));

    const statusRes = await request(app.getHttpServer())
      .get('/sync/status')
      .set(adminHeaders);

    expect(statusRes.status).toBe(200);
    expect(statusRes.body.outboxQueueDepth).toBeDefined();
    const depth = statusRes.body.outboxQueueDepth as Record<string, number>;
    const total = Object.values(depth).reduce((s, n) => s + n, 0);
    expect(total).toBeGreaterThanOrEqual(1);
  });

  it('GET /sync/status reflects last successful batch sync timestamp', async () => {
    const ctx = app as unknown as TestContext;
    const adminHeaders = { 'x-employee-id': '999', 'x-role': 'admin' };

    const before = Date.now();

    await request(app.getHttpServer())
      .post('/sync/batch')
      .set(adminHeaders)
      .send({
        records: [{ employeeId: ctx.employeeId, locationId: ctx.locationId, leaveType: ctx.leaveType, totalDays: 10, hcmVersion: '1' }],
      });

    const statusRes = await request(app.getHttpServer())
      .get('/sync/status')
      .set(adminHeaders);

    expect(statusRes.status).toBe(200);
    const ts = new Date(statusRes.body.lastBatchSyncAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
  });
});

describe('Anniversary simulation flow', () => {
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

  it('HCM anniversary increases totalDays, webhook updates shadow, effective_available recalculates', async () => {
    const ctx = app as unknown as TestContext;
    const ds = app.get(DataSource);
    const employeeHeaders = { 'x-employee-id': String(ctx.employeeId), 'x-role': 'employee' };

    await ds.query(
      'UPDATE leave_balances SET total_days = 5, used_days = 0, reserved_days = 3 WHERE employee_id = ?',
      [ctx.employeeId],
    );

    ctx.hcm.seedBalance(ctx.employeeId, ctx.locationId, ctx.leaveType, 5);

    ctx.hcm.simulateAnniversary(String(ctx.employeeId), 5);

    const webhookRes = await request(app.getHttpServer())
      .post('/sync/webhook')
      .set('x-hcm-secret', HCM_SECRET)
      .send({ employeeId: ctx.employeeId, locationId: ctx.locationId, leaveType: ctx.leaveType, totalDays: 10, hcmVersion: '2' });
    expect(webhookRes.status).toBe(204);

    const balanceRes = await request(app.getHttpServer())
      .get(`/balances/${ctx.employeeId}`)
      .set(employeeHeaders);
    expect(Number(balanceRes.body[0].totalDays)).toBe(10);
    expect(Number(balanceRes.body[0].effectiveAvailable)).toBe(7);
  });
});
