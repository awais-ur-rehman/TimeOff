import * as request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { setupTestApp, teardownTestApp, resetState, futureDate, TestContext } from './helpers/db.helper';

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

  function employeeHeaders(ctx: TestContext) {
    return { 'x-employee-id': String(ctx.employeeId), 'x-role': 'employee' };
  }
  function managerHeaders(ctx: TestContext) {
    return { 'x-employee-id': String(ctx.managerId), 'x-role': 'manager', 'x-location-id': ctx.locationId };
  }

  it('requesting 0 days returns 400', async () => {
    const ctx = app as unknown as TestContext;
    // endDate before startDate yields 0 or negative days — service rejects with 400
    const res = await request(app.getHttpServer())
      .post('/requests')
      .set(employeeHeaders(ctx))
      .send({ employeeId: ctx.employeeId, locationId: ctx.locationId, leaveType: ctx.leaveType, startDate: futureDate(2), endDate: futureDate(1) });
    expect(res.status).toBe(400);
  });

  it('requesting a negative number of days returns 400', async () => {
    const ctx = app as unknown as TestContext;
    const res = await request(app.getHttpServer())
      .post('/requests')
      .set(employeeHeaders(ctx))
      .send({ employeeId: ctx.employeeId, locationId: ctx.locationId, leaveType: ctx.leaveType, startDate: futureDate(5), endDate: futureDate(1) });
    expect(res.status).toBe(400);
  });

  it('end_date before start_date returns 400', async () => {
    const ctx = app as unknown as TestContext;
    const res = await request(app.getHttpServer())
      .post('/requests')
      .set(employeeHeaders(ctx))
      .send({ employeeId: ctx.employeeId, locationId: ctx.locationId, leaveType: ctx.leaveType, startDate: futureDate(3), endDate: futureDate(1) });
    expect(res.status).toBe(400);
  });

  it('start_date in the past returns 400', async () => {
    const ctx = app as unknown as TestContext;
    const past = new Date();
    past.setDate(past.getDate() - 5);
    const pastStr = past.toISOString().split('T')[0];
    const res = await request(app.getHttpServer())
      .post('/requests')
      .set(employeeHeaders(ctx))
      .send({ employeeId: ctx.employeeId, locationId: ctx.locationId, leaveType: ctx.leaveType, startDate: pastStr, endDate: futureDate(1) });
    expect(res.status).toBe(400);
  });

  it('unknown leave_type returns 422 with descriptive message', async () => {
    const ctx = app as unknown as TestContext;
    const res = await request(app.getHttpServer())
      .post('/requests')
      .set(employeeHeaders(ctx))
      .send({ employeeId: ctx.employeeId, locationId: ctx.locationId, leaveType: 'NONEXISTENT_TYPE', startDate: futureDate(1), endDate: futureDate(3) });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/balance/i);
  });

  it('unknown location_id returns 422 with descriptive message', async () => {
    const ctx = app as unknown as TestContext;
    const res = await request(app.getHttpServer())
      .post('/requests')
      .set(employeeHeaders(ctx))
      .send({ employeeId: ctx.employeeId, locationId: 'UNKNOWN_LOC', leaveType: ctx.leaveType, startDate: futureDate(1), endDate: futureDate(3) });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/balance/i);
  });

  it('submitting a request as a manager for someone else returns 403', async () => {
    const ctx = app as unknown as TestContext;
    const anotherEmployeeId = ctx.employeeId + 1;
    const res = await request(app.getHttpServer())
      .post('/requests')
      .set({ 'x-employee-id': String(ctx.employeeId), 'x-role': 'employee' })
      .send({ employeeId: anotherEmployeeId, locationId: ctx.locationId, leaveType: ctx.leaveType, startDate: futureDate(1), endDate: futureDate(3) });
    expect(res.status).toBe(403);
  });

  it('manager approving a request outside their location scope returns 403', async () => {
    const ctx = app as unknown as TestContext;
    const submitRes = await request(app.getHttpServer())
      .post('/requests')
      .set(employeeHeaders(ctx))
      .send({ employeeId: ctx.employeeId, locationId: ctx.locationId, leaveType: ctx.leaveType, startDate: futureDate(1), endDate: futureDate(3) });
    expect(submitRes.status).toBe(201);

    // Manager with different location tries to approve
    const wrongLocationManagerHeaders = {
      'x-employee-id': String(ctx.managerId),
      'x-role': 'manager',
      'x-location-id': 'DIFFERENT_LOC',
    };
    const approveRes = await request(app.getHttpServer())
      .patch(`/requests/${submitRes.body.id}/approve`)
      .set(wrongLocationManagerHeaders);
    expect(approveRes.status).toBe(403);
  });

  it('GET /requests/:id returns 404 for non-existent request', async () => {
    const ctx = app as unknown as TestContext;
    const res = await request(app.getHttpServer())
      .get('/requests/99999')
      .set(employeeHeaders(ctx));
    expect(res.status).toBe(404);
  });

  it('PATCH /requests/:id/approve on an already-approved request returns 409', async () => {
    const ctx = app as unknown as TestContext;
    const submitRes = await request(app.getHttpServer())
      .post('/requests')
      .set(employeeHeaders(ctx))
      .send({ employeeId: ctx.employeeId, locationId: ctx.locationId, leaveType: ctx.leaveType, startDate: futureDate(1), endDate: futureDate(3) });
    await request(app.getHttpServer())
      .patch(`/requests/${submitRes.body.id}/approve`)
      .set(managerHeaders(ctx));

    // Try to approve again
    const secondApprove = await request(app.getHttpServer())
      .patch(`/requests/${submitRes.body.id}/approve`)
      .set(managerHeaders(ctx));
    expect(secondApprove.status).toBe(400);
  });

  it('PATCH /requests/:id/reject on an already-rejected request returns 409', async () => {
    const ctx = app as unknown as TestContext;
    const submitRes = await request(app.getHttpServer())
      .post('/requests')
      .set(employeeHeaders(ctx))
      .send({ employeeId: ctx.employeeId, locationId: ctx.locationId, leaveType: ctx.leaveType, startDate: futureDate(1), endDate: futureDate(3) });

    await request(app.getHttpServer())
      .patch(`/requests/${submitRes.body.id}/reject`)
      .set(managerHeaders(ctx))
      .send({ reason: 'Capacity' });

    const secondReject = await request(app.getHttpServer())
      .patch(`/requests/${submitRes.body.id}/reject`)
      .set(managerHeaders(ctx))
      .send({ reason: 'Capacity' });
    expect(secondReject.status).toBe(400);
  });
});
