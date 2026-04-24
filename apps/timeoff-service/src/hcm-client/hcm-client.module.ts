import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { HcmClientService } from './hcm-client.service';

@Module({
  imports: [
    HttpModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        timeout: config.get<number>('HCM_REQUEST_TIMEOUT_MS', 8000),
        baseURL: config.get<string>('HCM_BASE_URL', 'http://localhost:3001'),
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [HcmClientService],
  exports: [HcmClientService],
})
export class HcmClientModule {}
