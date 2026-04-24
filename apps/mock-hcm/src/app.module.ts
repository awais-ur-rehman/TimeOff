import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HcmController } from './hcm.controller';
import { HcmService } from './hcm.service';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [HcmController],
  providers: [HcmService],
})
export class AppModule {}
