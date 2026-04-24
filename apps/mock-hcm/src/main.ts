import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('MockHcmBootstrap');
  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  logger.log(`Mock HCM server running on port ${port}`);
}

bootstrap();
