import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env' });

import { Employee } from './employee/employee.entity';
import { LeaveBalance } from './balance/balance.entity';
import { TimeOffRequest } from './request/request.entity';
import { OutboxEvent } from './outbox/outbox.entity';
import { SyncLog } from './sync/sync-log.entity';

export const AppDataSource = new DataSource({
  type: 'better-sqlite3',
  database: process.env.DATABASE_PATH || './data/timeoff.db',
  entities: [Employee, LeaveBalance, TimeOffRequest, OutboxEvent, SyncLog],
  migrations: ['apps/timeoff-service/src/migrations/*.ts'],
  synchronize: false,
});
