import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxEvent } from './outbox.entity';
import { OutboxProcessor } from './outbox.processor';
import { OutboxController } from './outbox.controller';
import { HcmClientModule } from '../hcm-client/hcm-client.module';

@Module({
  imports: [TypeOrmModule.forFeature([OutboxEvent]), HcmClientModule],
  controllers: [OutboxController],
  providers: [OutboxProcessor],
  exports: [OutboxProcessor],
})
export class OutboxModule {}
