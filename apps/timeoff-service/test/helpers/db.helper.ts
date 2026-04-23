import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';

/**
 * Boots the full NestJS application with in-memory SQLite for E2E tests.
 * The test environment is configured via apps/timeoff-service/.env.test.
 */
export async function setupTestApp(): Promise<INestApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  return app;
}

export async function teardownTestApp(app: INestApplication): Promise<void> {
  await app.close();
}

/**
 * Resets volatile state between tests:
 * - Resets mock HCM state via DELETE /hcm/state
 * - Truncates all tables except employees
 */
export async function resetState(app: INestApplication): Promise<void> {
  // Implementation added during Phase 3 (integration test fill-in)
}
