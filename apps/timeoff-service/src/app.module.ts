import { Module, OnApplicationBootstrap, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from './common/snake-naming.strategy';

import { Employee } from './employee/employee.entity';
import { LeaveBalance } from './balance/balance.entity';
import { TimeOffRequest } from './request/request.entity';
import { OutboxEvent } from './outbox/outbox.entity';
import { SyncLog } from './sync/sync-log.entity';

import { BalanceModule } from './balance/balance.module';
import { HcmClientModule } from './hcm-client/hcm-client.module';
import { EmployeeModule } from './employee/employee.module';
import { RequestModule } from './request/request.module';
import { OutboxModule } from './outbox/outbox.module';
import { SyncModule } from './sync/sync.module';
import { HealthController } from './health.controller';

const ALL_ENTITIES = [Employee, LeaveBalance, TimeOffRequest, OutboxEvent, SyncLog];

@Module({
  controllers: [HealthController],
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [
        `apps/timeoff-service/.env.${process.env.NODE_ENV}`,
        'apps/timeoff-service/.env.test',
        '.env',
      ],
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        type: 'better-sqlite3',
        database: config.get<string>('DATABASE_PATH', ':memory:'),
        entities: ALL_ENTITIES,
        namingStrategy: new SnakeNamingStrategy(),
        migrations: ['dist/apps/timeoff-service/migrations/*.js'],
        synchronize: process.env.NODE_ENV === 'test',
        migrationsRun: process.env.NODE_ENV !== 'test',
      }),
      inject: [ConfigService],
    }),
    TypeOrmModule.forFeature([OutboxEvent]),
    BalanceModule,
    HcmClientModule,
    EmployeeModule,
    RequestModule,
    OutboxModule,
    SyncModule,
  ],
})
export class AppModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(AppModule.name);

  constructor(private readonly dataSource: DataSource) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.dataSource.query('PRAGMA journal_mode=WAL;');
    await this.dataSource.query('PRAGMA foreign_keys=ON;');
    this.logger.log('SQLite pragmas set: WAL mode, foreign keys ON');
  }
}
