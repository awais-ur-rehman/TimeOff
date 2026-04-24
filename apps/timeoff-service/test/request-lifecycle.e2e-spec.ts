import * as request from 'supertest';
import { DataSource } from 'typeorm';
import {
  setupTestApp,
  teardownTestApp,
  resetState,
  futureDate,
  waitFor,
  TestContext,
} from './helpers/db.helper';
import { OutboxProcessor } from '../src/outbox/outbox.processor';

// ─── helpers ────────────────────────────────────────────────────────────────

function employeeHeaders(ctx: TestContext) {
  return {
    'x-employee-id': String(ctx.employeeId),
    'x-role': 'employee',
  };
}
function managerHeaders(ctx: TestContext) {
  return {
    'x-employee-id': String(ctx.managerId),
    'x-role': 'manager',
    'x-location-id': ctx.locationId,
  };
}

async function submitRequest(ctx: TestContext, days = 3) {
  const res = await request(ctx.app.getHttpServer())
    .post('/requests')
    .set(employeeHeaders(ctx))
    .send({
      employeeId: ctx.employeeId,
      locationId: ctx.locationId,
      leaveType: ctx.leaveType,
      startDate: futureDate(1),
      endDate: futureDate(days),
    });
  return res;
}

async function approveRequest(ctx: TestContext, id: number) {
  return request(ctx.app.getHttpServer())
    .patch(`/requests/${id}/approve`)
    .set(managerHeaders(ctx));
}

async function getBalance(ctx: TestContext) {
  const res = await request(ctx.app.getHttpServer())
    .get(`/balances/${ctx.employeeId}`)
    .set(employeeHeaders(ctx));
  return res.body[0];
}

async function getRequest(ctx: TestContext, id: number) {
  const res = await request(ctx.app.getHttpServer())
    .get(`/requests/${id}`)
    .set(employeeHeaders(ctx));
  return res.body;
}

async function dbQuery(ctx: TestContext, sql: string, params: unknown[] = []) {
  return ctx.app.get(DataSource).query(sql, params);
}

async function forceOutboxRetry(ctx: TestContext, requestId: number): Promise<void> {
  await dbQuery(
    ctx,
    "UPDATE outbox_events SET next_retry_at = datetime('now', '-1 second') WHERE request_id = ? AND event_type = 'HCM_DEDUCT'",
    [requestId],
  );
}

// ─── Full happy path ─────────────────────────────────────────────────────────

describe('Full happy path', () => {
  let ctx: TestContext;

  beforeAll(async () => { ctx = await setupTestApp(); });
  afterAll(async () => { await teardownTestApp(ctx); });
  beforeEach(async () => { await resetState(ctx); });

  it('employee submits request, manager approves, HCM confirms, balance moves from reserved to used', async () => {
    // 1. Submit 3-day request
    const submitRes = await submitRequest(ctx, 3);
    expect(submitRes.status).toBe(201);
    expect(submitRes.body.status).toBe('PENDING');

    const requestId: number = submitRes.body.id;

    // 2. Balance shows 7 effective available (10 - 3 reserved)
    const balance1 = await getBalance(ctx);
    expect(Number(balance1.effectiveAvailable)).toBe(7);
    expect(Number(balance1.reservedDays)).toBe(3);

    // 3. Manager approves
    const approveRes = await approveRequest(ctx, requestId);
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.status).toBe('APPROVED_PENDING_HCM');

    // 4. Wait for outbox processor to fire and HCM to confirm
    await waitFor(async () => {
      const req = await getRequest(ctx, requestId);
      return req.status === 'APPROVED';
    }, 3000, 100);

    // 5. Assert final state
    const finalReq = await getRequest(ctx, requestId);
    expect(finalReq.status).toBe('APPROVED');
    expect(finalReq.hcmRequestId).toBeTruthy();

    const finalBalance = await getBalance(ctx);
    expect(Number(finalBalance.reservedDays)).toBe(0);
    expect(Number(finalBalance.usedDays)).toBe(3);
    expect(Number(finalBalance.effectiveAvailable)).toBe(7);
  });
});

// ─── Insufficient balance ────────────────────────────────────────────────────

describe('Insufficient balance', () => {
  let ctx: TestContext;

  beforeAll(async () => { ctx = await setupTestApp(); });
  afterAll(async () => { await teardownTestApp(ctx); });
  beforeEach(async () => { await resetState(ctx); });

  it('returns 422 when employee requests more days than available', async () => {
    const res = await submitRequest(ctx, 11); // 11 days, only 10 available
    expect(res.status).toBe(422);
  });

  it('includes current effective_available in the 422 error detail', async () => {
    const res = await submitRequest(ctx, 11);
    expect(res.status).toBe(422);
    const detail = JSON.stringify(res.body.detail ?? res.body);
    expect(detail).toContain('10');
  });

  it('does not create a request record on 422', async () => {
    await submitRequest(ctx, 11);
    const rows = await dbQuery(ctx, 'SELECT COUNT(*) as c FROM time_off_requests');
    expect(rows[0].c).toBe(0);
  });

  it('does not modify reserved_days on 422', async () => {
    await submitRequest(ctx, 11);
    const balance = await getBalance(ctx);
    expect(Number(balance.reservedDays)).toBe(0);
  });
});

// ─── Manager rejection ───────────────────────────────────────────────────────

describe('Manager rejection', () => {
  let ctx: TestContext;

  beforeAll(async () => { ctx = await setupTestApp(); });
  afterAll(async () => { await teardownTestApp(ctx); });
  beforeEach(async () => { await resetState(ctx); });

  it('PATCH /requests/:id/reject moves request to REJECTED', async () => {
    const { body: req } = await submitRequest(ctx, 3);
    const res = await request(ctx.app.getHttpServer())
      .patch(`/requests/${req.id}/reject`)
      .set(managerHeaders(ctx))
      .send({ reason: 'Team at capacity' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('REJECTED');
  });

  it('releases reserved_days after rejection', async () => {
    const { body: req } = await submitRequest(ctx, 3);
    await request(ctx.app.getHttpServer())
      .patch(`/requests/${req.id}/reject`)
      .set(managerHeaders(ctx))
      .send({ reason: 'Overlap' });
    const balance = await getBalance(ctx);
    expect(Number(balance.reservedDays)).toBe(0);
    expect(Number(balance.effectiveAvailable)).toBe(10);
  });

  it('requires a rejection reason in the body', async () => {
    const { body: req } = await submitRequest(ctx, 3);
    const res = await request(ctx.app.getHttpServer())
      .patch(`/requests/${req.id}/reject`)
      .set(managerHeaders(ctx))
      .send({ reason: '' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when rejection reason is missing', async () => {
    const { body: req } = await submitRequest(ctx, 3);
    const res = await request(ctx.app.getHttpServer())
      .patch(`/requests/${req.id}/reject`)
      .set(managerHeaders(ctx))
      .send({});
    expect(res.status).toBe(400);
  });
});

// ─── Cancellation before approval ────────────────────────────────────────────

describe('Employee cancellation before approval', () => {
  let ctx: TestContext;

  beforeAll(async () => { ctx = await setupTestApp(); });
  afterAll(async () => { await teardownTestApp(ctx); });
  beforeEach(async () => { await resetState(ctx); });

  it('DELETE /requests/:id while PENDING releases reserved_days', async () => {
    const { body: req } = await submitRequest(ctx, 3);
    const delRes = await request(ctx.app.getHttpServer())
      .delete(`/requests/${req.id}`)
      .set(employeeHeaders(ctx));
    expect(delRes.status).toBe(204);
    const balance = await getBalance(ctx);
    expect(Number(balance.reservedDays)).toBe(0);
  });

  it('does not write an outbox event when cancelling a PENDING request', async () => {
    const { body: req } = await submitRequest(ctx, 3);
    await request(ctx.app.getHttpServer())
      .delete(`/requests/${req.id}`)
      .set(employeeHeaders(ctx));
    const rows = await dbQuery(ctx, 'SELECT COUNT(*) as c FROM outbox_events');
    expect(rows[0].c).toBe(0);
  });

  it('returns 404 when request does not exist', async () => {
    const res = await request(ctx.app.getHttpServer())
      .delete('/requests/99999')
      .set(employeeHeaders(ctx));
    expect(res.status).toBe(404);
  });

  it('returns 409 when request is already in a terminal state', async () => {
    const { body: req } = await submitRequest(ctx, 3);
    // Reject first (puts it in terminal state)
    await request(ctx.app.getHttpServer())
      .patch(`/requests/${req.id}/reject`)
      .set(managerHeaders(ctx))
      .send({ reason: 'No capacity' });
    // Try to cancel the already-rejected request
    const delRes = await request(ctx.app.getHttpServer())
      .delete(`/requests/${req.id}`)
      .set(employeeHeaders(ctx));
    expect(delRes.status).toBe(409);
  });
});

// ─── Cancellation after approval ─────────────────────────────────────────────

describe('Employee cancellation after approval', () => {
  let ctx: TestContext;

  beforeAll(async () => { ctx = await setupTestApp(); });
  afterAll(async () => { await teardownTestApp(ctx); });
  beforeEach(async () => { await resetState(ctx); });

  it('DELETE /requests/:id while APPROVED_PENDING_HCM writes HCM_REVERSE outbox event', async () => {
    const { body: req } = await submitRequest(ctx, 3);
    await approveRequest(ctx, req.id);
    await request(ctx.app.getHttpServer())
      .delete(`/requests/${req.id}`)
      .set(employeeHeaders(ctx));
    const rows = await dbQuery(
      ctx,
      "SELECT * FROM outbox_events WHERE event_type = 'HCM_REVERSE' AND request_id = ?",
      [req.id],
    );
    expect(rows.length).toBe(1);
  });

  it('releases reserved_days immediately on cancellation', async () => {
    const { body: req } = await submitRequest(ctx, 3);
    await approveRequest(ctx, req.id);
    await request(ctx.app.getHttpServer())
      .delete(`/requests/${req.id}`)
      .set(employeeHeaders(ctx));
    const balance = await getBalance(ctx);
    expect(Number(balance.reservedDays)).toBe(0);
  });

  it('HCM_REVERSE event is processed by outbox and calls mock HCM DELETE endpoint', async () => {
    const { body: req } = await submitRequest(ctx, 3);
    await approveRequest(ctx, req.id);

    // Cancel immediately while APPROVED_PENDING_HCM — creates HCM_REVERSE event.
    // The HCM_DEDUCT event will still fire, set hcmRequestId on the (now CANCELLED)
    // request, and then the HCM_REVERSE will pick it up and call DELETE.
    const delRes = await request(ctx.app.getHttpServer())
      .delete(`/requests/${req.id}`)
      .set(employeeHeaders(ctx));
    expect(delRes.status).toBe(204);

    // Wait for HCM_REVERSE event to be processed (depends on DEDUCT setting hcmRequestId first)
    await waitFor(async () => {
      const rows = await dbQuery(
        ctx,
        "SELECT status FROM outbox_events WHERE event_type = 'HCM_REVERSE' AND request_id = ?",
        [req.id],
      );
      return rows[0]?.status === 'DONE';
    }, 5000, 100);

    const reverseEvents = await dbQuery(
      ctx,
      "SELECT status FROM outbox_events WHERE event_type = 'HCM_REVERSE' AND request_id = ?",
      [req.id],
    );
    expect(reverseEvents[0].status).toBe('DONE');
  });
});

// ─── HCM failure on deduction ────────────────────────────────────────────────

describe('HCM failure on deduction', () => {
  let ctx: TestContext;

  beforeAll(async () => { ctx = await setupTestApp(); });
  afterAll(async () => { await teardownTestApp(ctx); });
  beforeEach(async () => {
    await resetState(ctx);
    ctx.hcm.setErrorRate(1.0); // All HCM calls fail
  });

  it('request stays in APPROVED_PENDING_HCM when HCM returns 500', async () => {
    const { body: req } = await submitRequest(ctx, 3);
    await approveRequest(ctx, req.id);

    await waitFor(async () => {
      const rows = await dbQuery(
        ctx,
        "SELECT attempts FROM outbox_events WHERE request_id = ? AND event_type = 'HCM_DEDUCT'",
        [req.id],
      );
      return rows[0]?.attempts === 1;
    }, 3000, 100);

    const current = await getRequest(ctx, req.id);
    expect(current.status).toBe('APPROVED_PENDING_HCM');
  });

  it('outbox event retries up to HCM_MAX_RETRIES times', async () => {
    const processor = ctx.app.get(OutboxProcessor);
    const { body: req } = await submitRequest(ctx, 3);
    await approveRequest(ctx, req.id);

    await waitFor(async () => {
      const rows = await dbQuery(
        ctx,
        "SELECT attempts FROM outbox_events WHERE request_id = ? AND event_type = 'HCM_DEDUCT'",
        [req.id],
      );
      return rows[0]?.attempts === 1;
    }, 3000, 100);

    await forceOutboxRetry(ctx, req.id);
    await processor.tick();
    await waitFor(async () => {
      const rows = await dbQuery(
        ctx,
        "SELECT attempts FROM outbox_events WHERE request_id = ? AND event_type = 'HCM_DEDUCT'",
        [req.id],
      );
      return rows[0]?.attempts === 2;
    }, 3000, 100);

    await forceOutboxRetry(ctx, req.id);
    await processor.tick();
    await waitFor(async () => {
      const rows = await dbQuery(
        ctx,
        "SELECT attempts FROM outbox_events WHERE request_id = ? AND event_type = 'HCM_DEDUCT'",
        [req.id],
      );
      return rows[0]?.attempts === 3;
    }, 3000, 100);

    await forceOutboxRetry(ctx, req.id);
    await processor.tick();

    const rows = await dbQuery(
      ctx,
      "SELECT attempts, status FROM outbox_events WHERE request_id = ? AND event_type = 'HCM_DEDUCT'",
      [req.id],
    );
    expect(rows[0].attempts).toBe(4);
    expect(rows[0].status).toBe('FAILED');
  });

  it('request moves to FAILED after max retries exhausted', async () => {
    const processor = ctx.app.get(OutboxProcessor);
    const { body: req } = await submitRequest(ctx, 3);
    await approveRequest(ctx, req.id);

    await waitFor(async () => {
      const rows = await dbQuery(
        ctx,
        "SELECT attempts FROM outbox_events WHERE request_id = ? AND event_type = 'HCM_DEDUCT'",
        [req.id],
      );
      return rows[0]?.attempts === 1;
    }, 3000, 100);

    for (let attempt = 0; attempt < 3; attempt++) {
      await forceOutboxRetry(ctx, req.id);
      await processor.tick();
    }

    await waitFor(async () => {
      const current = await getRequest(ctx, req.id);
      return current.status === 'FAILED';
    }, 3000, 100);

    const current = await getRequest(ctx, req.id);
    expect(current.status).toBe('FAILED');
  });

  it('reserved_days stays reserved when request is FAILED (not released)', async () => {
    const processor = ctx.app.get(OutboxProcessor);
    const { body: req } = await submitRequest(ctx, 3);
    await approveRequest(ctx, req.id);

    await waitFor(async () => {
      const rows = await dbQuery(
        ctx,
        "SELECT attempts FROM outbox_events WHERE request_id = ? AND event_type = 'HCM_DEDUCT'",
        [req.id],
      );
      return rows[0]?.attempts === 1;
    }, 3000, 100);

    for (let attempt = 0; attempt < 3; attempt++) {
      await forceOutboxRetry(ctx, req.id);
      await processor.tick();
    }

    await waitFor(async () => {
      const current = await getRequest(ctx, req.id);
      return current.status === 'FAILED';
    }, 3000, 100);

    const balance = await getBalance(ctx);
    expect(Number(balance.reservedDays)).toBe(3);
  });
});

// ─── Cancellation after FAILED state ─────────────────────────────────────────

describe('Cancellation after FAILED state', () => {
  let ctx: TestContext;

  beforeAll(async () => { ctx = await setupTestApp(); });
  afterAll(async () => { await teardownTestApp(ctx); });
  beforeEach(async () => {
    await resetState(ctx);
    ctx.hcm.setErrorRate(1.0);
  });

  it('returns 409 when cancelling a FAILED request', async () => {
    const processor = ctx.app.get(OutboxProcessor);
    const { body: req } = await submitRequest(ctx, 3);
    await approveRequest(ctx, req.id);

    await waitFor(async () => {
      const rows = await dbQuery(
        ctx,
        "SELECT attempts FROM outbox_events WHERE request_id = ? AND event_type = 'HCM_DEDUCT'",
        [req.id],
      );
      return rows[0]?.attempts === 1;
    }, 3000, 100);

    for (let attempt = 0; attempt < 3; attempt++) {
      await forceOutboxRetry(ctx, req.id);
      await processor.tick();
    }

    await waitFor(async () => {
      const current = await getRequest(ctx, req.id);
      return current.status === 'FAILED';
    }, 3000, 100);

    const res = await request(ctx.app.getHttpServer())
      .delete(`/requests/${req.id}`)
      .set(employeeHeaders(ctx));
    expect(res.status).toBe(409);
  });
});
