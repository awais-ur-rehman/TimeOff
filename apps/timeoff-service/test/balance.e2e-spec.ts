import * as request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { LeaveBalance } from '../src/balance/balance.entity';
import { setupTestApp, teardownTestApp, resetState, TestContext } from './helpers/db.helper';

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

  it('returns all balance records for an employee with effective_available calculated', async () => {
    const ctx = app as TestContext;
    const ds = app.get(DataSource);

    await ds.manager.save(LeaveBalance, {
      employeeId: ctx.employeeId,
      locationId: 'LOC2',
      leaveType: 'SICK',
      totalDays: 8,
      usedDays: 2,
      reservedDays: 1,
      version: 0,
    });

    const res = await request(app.getHttpServer())
      .get(`/balances/${ctx.employeeId}`)
      .set({ 'x-employee-id': String(ctx.employeeId), 'x-role': 'employee' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const sickBalance = res.body.find((balance: { locationId: string }) => balance.locationId === 'LOC2');
    expect(Number(sickBalance.effectiveAvailable)).toBe(5);
  });

  it('returns 403 when caller is a different employee', async () => {
    const ctx = app as TestContext;

    const res = await request(app.getHttpServer())
      .get(`/balances/${ctx.employeeId}`)
      .set({ 'x-employee-id': String(ctx.employeeId + 999), 'x-role': 'employee' });

    expect(res.status).toBe(403);
  });

  it('returns 200 when caller is a manager', async () => {
    const ctx = app as TestContext;

    const res = await request(app.getHttpServer())
      .get(`/balances/${ctx.employeeId}`)
      .set({
        'x-employee-id': String(ctx.managerId),
        'x-role': 'manager',
        'x-location-id': ctx.locationId,
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('returns 404 when employee does not exist', async () => {
    const ctx = app as TestContext;

    const res = await request(app.getHttpServer())
      .get('/balances/99999')
      .set({
        'x-employee-id': String(ctx.managerId),
        'x-role': 'manager',
        'x-location-id': ctx.locationId,
      });

    expect(res.status).toBe(404);
  });
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

  it('returns balance for specific location only', async () => {
    const ctx = app as TestContext;
    const ds = app.get(DataSource);

    await ds.manager.save(LeaveBalance, {
      employeeId: ctx.employeeId,
      locationId: 'LOC2',
      leaveType: 'SICK',
      totalDays: 6,
      usedDays: 1,
      reservedDays: 1,
      version: 0,
    });

    const res = await request(app.getHttpServer())
      .get(`/balances/${ctx.employeeId}/LOC2`)
      .set({ 'x-employee-id': String(ctx.employeeId), 'x-role': 'employee' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].locationId).toBe('LOC2');
  });

  it('returns 404 when no balance exists for that location', async () => {
    const ctx = app as TestContext;

    const res = await request(app.getHttpServer())
      .get(`/balances/${ctx.employeeId}/UNKNOWN`)
      .set({ 'x-employee-id': String(ctx.employeeId), 'x-role': 'employee' });

    expect(res.status).toBe(404);
  });
});
