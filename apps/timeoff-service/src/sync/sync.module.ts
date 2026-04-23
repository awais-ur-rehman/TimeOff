import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SyncLog } from './sync-log.entity';

@Module({
  imports: [TypeOrmModule.forFeature([SyncLog])],
  providers: [],
  exports: [],
})
export class SyncModule {}
