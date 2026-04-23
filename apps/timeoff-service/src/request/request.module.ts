import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TimeOffRequest } from './request.entity';

@Module({
  imports: [TypeOrmModule.forFeature([TimeOffRequest])],
  providers: [],
  exports: [],
})
export class RequestModule {}
