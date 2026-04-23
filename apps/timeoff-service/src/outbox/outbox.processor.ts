import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { OutboxEvent } from './outbox.entity';
import { HcmClientService } from '../hcm-client/hcm-client.service';

const BACKOFF_SECONDS = [0, 30, 300, 1800];

@Injectable()
export class OutboxProcessor {
  private readonly logger = new Logger(OutboxProcessor.name);

  constructor(
    @InjectRepository(OutboxEvent)
    private readonly outboxRepo: Repository<OutboxEvent>,
    private readonly hcmClient: HcmClientService,
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {}

  calculateNextRetryAt(attempts: number): Date {
    const delaySec =
      BACKOFF_SECONDS[attempts] ?? BACKOFF_SECONDS[BACKOFF_SECONDS.length - 1];
    const next = new Date();
    next.setSeconds(next.getSeconds() + delaySec);
    return next;
  }

  shouldMarkFailed(attempts: number): boolean {
    const maxRetries = this.configService?.get<number>('HCM_MAX_RETRIES') ?? 4;
    return attempts >= maxRetries;
  }
}
