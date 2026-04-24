import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxEvent } from './outbox.entity';
import { OutboxProcessor } from './outbox.processor';
import { OutboxController } from './outbox.controller';
import { HcmClientModule } from '../hcm-client/hcm-client.module';
import { RequestModule } from '../request/request.module';

@Module({
  imports: [TypeOrmModule.forFeature([OutboxEvent]), HcmClientModule, RequestModule],
  controllers: [OutboxController],
  providers: [OutboxProcessor],
  exports: [OutboxProcessor],
})
export class OutboxModule {}
