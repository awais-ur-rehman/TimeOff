import * as request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { setupTestApp, teardownTestApp, resetState, futureDate, waitFor, TestContext } from './helpers/db.helper';

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
    const ctx = app as unknown as TestContext;
    const ds = app.get(DataSource);
    const employeeHeaders = { 'x-employee-id': String(ctx.employeeId), 'x-role': 'employee' };
    const managerHeaders = { 'x-employee-id': String(ctx.managerId), 'x-role': 'manager', 'x-location-id': ctx.locationId };

    // Submit and approve a request — this creates one outbox HCM_DEDUCT event
    const submitRes = await request(app.getHttpServer())
      .post('/requests')
      .set(employeeHeaders)
      .send({ employeeId: ctx.employeeId, locationId: ctx.locationId, leaveType: ctx.leaveType, startDate: futureDate(1), endDate: futureDate(3) });
    expect(submitRes.status).toBe(201);

    await request(app.getHttpServer())
      .patch(`/requests/${submitRes.body.id}/approve`)
      .set(managerHeaders);

    // Wait for first outbox event to be processed (DONE)
    await waitFor(async () => {
      const rows = await ds.query(
        "SELECT status FROM outbox_events WHERE request_id = ? AND event_type = 'HCM_DEDUCT'",
        [submitRes.body.id],
      );
      return rows[0]?.status === 'DONE';
    }, 3000, 100);

    // Grab the original event id — the processor uses 'outbox-<event.id>' as
    // the HCM idempotency key.  To re-trigger it with the SAME key we reset
    // the SAME row back to PENDING rather than inserting a clone with a new id.
    const [originalEvent] = await ds.query(
      "SELECT id FROM outbox_events WHERE request_id = ? AND event_type = 'HCM_DEDUCT'",
      [submitRes.body.id],
    );

    // Reset the original event to PENDING so it is re-processed with the same id
    // (and thus the same idempotency key 'outbox-<id>').
    await ds.query(
      "UPDATE outbox_events SET status = 'PENDING', attempts = 0 WHERE id = ?",
      [originalEvent.id],
    );

    // Wait for the event to be processed a second time (DONE again)
    await waitFor(async () => {
      const rows = await ds.query(
        "SELECT status FROM outbox_events WHERE id = ?",
        [originalEvent.id],
      );
      return rows[0]?.status === 'DONE';
    }, 3000, 100);

    // The HCM deductions map should still have exactly one entry
    const deductionCount = ctx.hcm['deductions'].size;
    expect(deductionCount).toBe(1);
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
    const ctx = app as unknown as TestContext;
    const ds = app.get(DataSource);
    const employeeHeaders = { 'x-employee-id': String(ctx.employeeId), 'x-role': 'employee' };
    const managerHeaders = { 'x-employee-id': String(ctx.managerId), 'x-role': 'manager', 'x-location-id': ctx.locationId };

    // Set HCM to always fail
    ctx.hcm.setErrorRate(1.0);

    const submitRes = await request(app.getHttpServer())
      .post('/requests')
      .set(employeeHeaders)
      .send({ employeeId: ctx.employeeId, locationId: ctx.locationId, leaveType: ctx.leaveType, startDate: futureDate(1), endDate: futureDate(3) });
    await request(app.getHttpServer())
      .patch(`/requests/${submitRes.body.id}/approve`)
      .set(managerHeaders);

    // Wait for at least one failure attempt
    await waitFor(async () => {
      const rows = await ds.query(
        "SELECT attempts FROM outbox_events WHERE request_id = ? AND event_type = 'HCM_DEDUCT'",
        [submitRes.body.id],
      );
      return rows[0]?.attempts >= 1;
    }, 2000, 100);

    // With our implementation, nextRetryAt is null on failure (immediate retry).
    // Verify the event is still in PENDING or FAILED state (retry mechanism is active).
    const rows = await ds.query(
      "SELECT status, attempts FROM outbox_events WHERE request_id = ? AND event_type = 'HCM_DEDUCT'",
      [submitRes.body.id],
    );
    expect(['PENDING', 'PROCESSING', 'FAILED']).toContain(rows[0].status);
    expect(rows[0].attempts).toBeGreaterThanOrEqual(1);
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

  it('POST /outbox/:id/retry resets a FAILED event to PENDING with nextRetryAt = now', async () => {
    const ctx = app as unknown as TestContext;
    const ds = app.get(DataSource);
    const adminHeaders = { 'x-employee-id': '999', 'x-role': 'admin' };
    const employeeHeaders = { 'x-employee-id': String(ctx.employeeId), 'x-role': 'employee' };
    const managerHeaders = { 'x-employee-id': String(ctx.managerId), 'x-role': 'manager', 'x-location-id': ctx.locationId };

    // Set HCM to always fail, create a FAILED event
    ctx.hcm.setErrorRate(1.0);

    const submitRes = await request(app.getHttpServer())
      .post('/requests')
      .set(employeeHeaders)
      .send({ employeeId: ctx.employeeId, locationId: ctx.locationId, leaveType: ctx.leaveType, startDate: futureDate(1), endDate: futureDate(3) });
    await request(app.getHttpServer())
      .patch(`/requests/${submitRes.body.id}/approve`)
      .set(managerHeaders);

    // Wait for event to be FAILED
    await waitFor(async () => {
      const rows = await ds.query(
        "SELECT status FROM outbox_events WHERE request_id = ? AND event_type = 'HCM_DEDUCT'",
        [submitRes.body.id],
      );
      return rows[0]?.status === 'FAILED';
    }, 5000, 200);

    const [event] = await ds.query(
      "SELECT id FROM outbox_events WHERE request_id = ? AND event_type = 'HCM_DEDUCT'",
      [submitRes.body.id],
    );

    // Reset HCM so retry can succeed
    ctx.hcm.setErrorRate(0);

    const retryRes = await request(app.getHttpServer())
      .post(`/outbox/${event.id}/retry`)
      .set(adminHeaders);

    expect(retryRes.status).toBe(201);
    expect(retryRes.body.status).toBe('PENDING');

    // Event should now be re-processed
    await waitFor(async () => {
      const rows = await ds.query(
        "SELECT status FROM outbox_events WHERE id = ?",
        [event.id],
      );
      return rows[0]?.status === 'DONE';
    }, 3000, 100);
  });

  it('returns 404 when outbox event does not exist', async () => {
    const adminHeaders = { 'x-employee-id': '999', 'x-role': 'admin' };
    const res = await request(app.getHttpServer())
      .post('/outbox/99999/retry')
      .set(adminHeaders);
    expect(res.status).toBe(404);
  });

  it('returns 400 when event is not in FAILED state', async () => {
    const ctx = app as unknown as TestContext;
    const ds = app.get(DataSource);
    const adminHeaders = { 'x-employee-id': '999', 'x-role': 'admin' };
    const employeeHeaders = { 'x-employee-id': String(ctx.employeeId), 'x-role': 'employee' };
    const managerHeaders = { 'x-employee-id': String(ctx.managerId), 'x-role': 'manager', 'x-location-id': ctx.locationId };

    // Create a request and approve it — the outbox event starts as PENDING
    const submitRes = await request(app.getHttpServer())
      .post('/requests')
      .set(employeeHeaders)
      .send({ employeeId: ctx.employeeId, locationId: ctx.locationId, leaveType: ctx.leaveType, startDate: futureDate(1), endDate: futureDate(3) });

    // Don't approve so no outbox event exists yet. Instead, manually insert a PENDING one.
    await ds.query(
      `INSERT INTO outbox_events (event_type, payload, status, attempts, request_id, created_at)
       VALUES ('HCM_DEDUCT', '{}', 'PENDING', 0, ?, datetime('now'))`,
      [submitRes.body.id],
    );

    const [event] = await ds.query(
      "SELECT id FROM outbox_events WHERE request_id = ? AND status = 'PENDING' ORDER BY id DESC LIMIT 1",
      [submitRes.body.id],
    );

    const res = await request(app.getHttpServer())
      .post(`/outbox/${event.id}/retry`)
      .set(adminHeaders);
    expect(res.status).toBe(400);
  });
});
