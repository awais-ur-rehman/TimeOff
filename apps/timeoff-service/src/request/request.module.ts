import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TimeOffRequest } from './request.entity';
import { OutboxEvent } from '../outbox/outbox.entity';
import { RequestService } from './request.service';
import { RequestController } from './request.controller';
import { BalanceModule } from '../balance/balance.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([TimeOffRequest, OutboxEvent]),
    BalanceModule,
  ],
  controllers: [RequestController],
  providers: [RequestService],
  exports: [RequestService],
})
export class RequestModule {}
