import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxEvent } from './outbox.entity';
import { OutboxProcessor } from './outbox.processor';
import { HcmClientModule } from '../hcm-client/hcm-client.module';

@Module({
  imports: [TypeOrmModule.forFeature([OutboxEvent]), HcmClientModule],
  providers: [OutboxProcessor],
  exports: [OutboxProcessor],
})
export class OutboxModule {}
