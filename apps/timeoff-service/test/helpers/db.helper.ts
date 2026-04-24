import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter';
import { Employee } from '../../src/employee/employee.entity';
import { LeaveBalance } from '../../src/balance/balance.entity';
import { acquireMockHcm, MockHcmServer, releaseMockHcm } from './mock-hcm-server';

/**
 * TestContext extends INestApplication so it can be stored in either a typed
 * `TestContext` variable (request-lifecycle tests) or an `INestApplication`
 * variable (other test suites with empty bodies).
 */
export type TestContext = INestApplication & {
  app: INestApplication;
  employeeId: number;
  managerId: number;
  locationId: string;
  leaveType: string;
  hcm: MockHcmServer;
};

const LOCATION_ID = 'LOC1';
const LEAVE_TYPE = 'ANNUAL';
const MANAGER_ID = 100;
const TOTAL_DAYS = 10;

export async function setupTestApp(): Promise<TestContext> {
  const hcm = await acquireMockHcm(3099);

  process.env.NODE_ENV = 'test';
  process.env.DATABASE_PATH = ':memory:';
  process.env.HCM_BASE_URL = 'http://localhost:3099';
  process.env.HCM_SECRET = 'test-secret';
  process.env.OUTBOX_POLL_INTERVAL_MS = '100';
  process.env.HCM_REQUEST_TIMEOUT_MS = '2000';
  process.env.HCM_MAX_RETRIES = '4';

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();

  const { employeeId } = await seedBaseData(app);

  // Augment the app instance with TestContext properties.
  // Because TestContext = INestApplication & ExtraProps, the returned object
  // satisfies both `TestContext` and `INestApplication` variable assignments.
  const ctx = Object.assign(app, {
    app,
    employeeId,
    managerId: MANAGER_ID,
    locationId: LOCATION_ID,
    leaveType: LEAVE_TYPE,
    hcm,
  }) as TestContext;

  return ctx;
}

export async function teardownTestApp(ctx: INestApplication): Promise<void> {
  await ctx.close();
  await releaseMockHcm();
}

/**
 * Resets volatile state between tests:
 * - Clears requests, outbox events, and leave balances
 * - Re-seeds the initial balance (10 days available) when called with a TestContext
 * - Resets mock HCM in-memory state when called with a TestContext
 */
export async function resetState(ctx: INestApplication): Promise<void> {
  const ds = ctx.get(DataSource);

  await ds.query('DELETE FROM outbox_events');
  await ds.query('DELETE FROM time_off_requests');
  await ds.query('DELETE FROM leave_balances');

  const tc = ctx as TestContext;
  if (tc.employeeId) {
    await ds.manager.save(LeaveBalance, {
      employeeId: tc.employeeId,
      locationId: LOCATION_ID,
      leaveType: LEAVE_TYPE,
      totalDays: TOTAL_DAYS,
      usedDays: 0,
      reservedDays: 0,
      version: 0,
    });
  }

  if (tc.hcm) {
    tc.hcm.resetState();
  }
}

async function seedBaseData(app: INestApplication): Promise<{ employeeId: number }> {
  const ds = app.get(DataSource);

  const employee = await ds.manager.save(Employee, {
    hcmEmployeeId: 'HCM-001',
    name: 'Test Employee',
    locationId: LOCATION_ID,
  });

  await ds.manager.save(LeaveBalance, {
    employeeId: employee.id,
    locationId: LOCATION_ID,
    leaveType: LEAVE_TYPE,
    totalDays: TOTAL_DAYS,
    usedDays: 0,
    reservedDays: 0,
    version: 0,
  });

  return { employeeId: employee.id };
}

/** Returns a date string N days from today in YYYY-MM-DD format. */
export function futureDate(daysFromNow: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().split('T')[0];
}

/** Waits up to maxMs for predicate to return true, polling every intervalMs. */
export async function waitFor(
  predicate: () => Promise<boolean>,
  maxMs = 3000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${maxMs}ms`);
}
