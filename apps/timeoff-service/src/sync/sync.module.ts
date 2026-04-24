import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { SyncLog } from './sync-log.entity';
import { SyncService } from './sync.service';
import { SyncController } from './sync.controller';
import { LeaveBalance } from '../balance/balance.entity';
import { TimeOffRequest } from '../request/request.entity';
import { OutboxEvent } from '../outbox/outbox.entity';
import { BalanceModule } from '../balance/balance.module';
import { HcmClientModule } from '../hcm-client/hcm-client.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([SyncLog, LeaveBalance, TimeOffRequest, OutboxEvent]),
    BalanceModule,
    HcmClientModule,
  ],
  controllers: [SyncController],
  providers: [SyncService],
  exports: [SyncService],
})
export class SyncModule {}
