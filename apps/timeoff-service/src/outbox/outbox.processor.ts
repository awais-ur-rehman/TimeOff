import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, LessThanOrEqual, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { OutboxEvent, OutboxEventStatus } from './outbox.entity';
import { HcmClientService } from '../hcm-client/hcm-client.service';
import { OutboxEventType } from '../common/enums/outbox-event-type.enum';
import { RequestService } from '../request/request.service';

const BACKOFF_SECONDS = [0, 30, 300, 1800];

interface DeductPayload {
  employeeId: number;
  locationId: string;
  leaveType: string;
  days: number;
}

@Injectable()
export class OutboxProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxProcessor.name);
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(
    @InjectRepository(OutboxEvent)
    private readonly outboxRepo: Repository<OutboxEvent>,
    private readonly hcmClient: HcmClientService,
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
    private readonly requestService: RequestService,
  ) {}

  onModuleInit(): void {
    const intervalMs = this.configService.get<number>('OUTBOX_POLL_INTERVAL_MS', 5000);
    this.intervalHandle = setInterval(() => {
      this.tick().catch((err: unknown) => {
        this.logger.error('Outbox tick error', err);
      });
    }, intervalMs);
    this.logger.log(`Outbox processor started (interval ${intervalMs}ms)`);
  }

  onModuleDestroy(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  calculateNextRetryAt(attempts: number): Date {
    const isTest = this.configService.get<string>('NODE_ENV') === 'test';
    const delaySec = isTest 
      ? 0 
      : (BACKOFF_SECONDS[attempts] ?? BACKOFF_SECONDS[BACKOFF_SECONDS.length - 1]);
    const next = new Date();
    next.setSeconds(next.getSeconds() + delaySec);
    return next;
  }

  shouldMarkFailed(attempts: number): boolean {
    const maxRetries = this.configService.get<number>('HCM_MAX_RETRIES', 4);
    return attempts >= maxRetries;
  }

  async tick(): Promise<void> {
    const now = new Date();

    const events = await this.outboxRepo.find({
      where: [
        { status: OutboxEventStatus.PENDING, nextRetryAt: IsNull() },
        { status: OutboxEventStatus.PENDING, nextRetryAt: LessThanOrEqual(now) },
      ],
      order: { createdAt: 'ASC' },
      take: 10,
    });

    if (events.length === 0) {
      return;
    }

    for (const event of events) {
      const claimed = await this.outboxRepo.update(
        { id: event.id, status: OutboxEventStatus.PENDING },
        { status: OutboxEventStatus.PROCESSING },
      );
      if ((claimed.affected ?? 0) === 0) {
        continue;
      }
      await this.processEvent({ ...event, status: OutboxEventStatus.PROCESSING });
    }
  }

  private async processEvent(event: OutboxEvent): Promise<void> {
    try {
      if (event.eventType === OutboxEventType.HCM_DEDUCT) {
        await this.processDeductEvent(event);
        return;
      }
      if (event.eventType === OutboxEventType.HCM_REVERSE) {
        await this.processReverseEvent(event);
        return;
      }
      throw new Error(`Unsupported outbox event type: ${event.eventType}`);
    } catch (error: unknown) {
      this.logger.error(`Outbox event ${event.id} (${event.eventType}) failed`, error);
      await this.handleEventFailure(event);
    }
  }

  private async processDeductEvent(event: OutboxEvent): Promise<void> {
    const payload = JSON.parse(event.payload) as DeductPayload;
    const idempotencyKey = `outbox-${event.id}`;
    const hcmRequestId = await this.hcmClient.deductBalance(
      payload.employeeId,
      payload.locationId,
      payload.leaveType,
      payload.days,
      idempotencyKey,
    );

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await this.requestService.completeDeductionFromOutbox(qr, event.requestId, hcmRequestId);
      await qr.manager.update(OutboxEvent, event.id, {
        status: OutboxEventStatus.DONE,
      });
      await qr.commitTransaction();
      this.logger.log(`Event ${event.id} DONE — request ${event.requestId} hcmRequestId=${hcmRequestId}`);
    } catch (error) {
      await qr.rollbackTransaction();
      throw error;
    } finally {
      await qr.release();
    }
  }

  private async processReverseEvent(event: OutboxEvent): Promise<void> {
    const rows = await this.dataSource.query(
      'SELECT hcm_request_id FROM time_off_requests WHERE id = ?',
      [event.requestId],
    ) as Array<{ hcm_request_id: string | null }>;

    const hcmRequestId = rows[0]?.hcm_request_id;
    if (!hcmRequestId) {
      throw new Error(`hcm_request_id not yet set on request ${event.requestId} — retrying`);
    }

    await this.hcmClient.reverseDeduction(hcmRequestId);
    await this.outboxRepo.update(event.id, { status: OutboxEventStatus.DONE });
    this.logger.log(`Event ${event.id} HCM_REVERSE DONE — reversed ${hcmRequestId}`);
  }

  private async handleEventFailure(event: OutboxEvent): Promise<void> {
    const newAttempts = event.attempts + 1;

    if (this.shouldMarkFailed(newAttempts)) {
      if (event.eventType === OutboxEventType.HCM_DEDUCT) {
        const qr = this.dataSource.createQueryRunner();
        await qr.connect();
        await qr.startTransaction();
        try {
          await qr.manager.update(OutboxEvent, event.id, {
            status: OutboxEventStatus.FAILED,
            attempts: newAttempts,
          });
          await this.requestService.failRequestFromOutbox(qr, event.requestId);
          await qr.commitTransaction();
        } catch (error) {
          await qr.rollbackTransaction();
          throw error;
        } finally {
          await qr.release();
        }
      } else {
        await this.outboxRepo.update(event.id, {
          status: OutboxEventStatus.FAILED,
          attempts: newAttempts,
        });
      }

      this.logger.error(`Event ${event.id} exhausted all retries`);
      return;
    }

    const nextRetryAt = this.calculateNextRetryAt(newAttempts);
    await this.outboxRepo.update(event.id, {
      status: OutboxEventStatus.PENDING,
      attempts: newAttempts,
      nextRetryAt,
    });
    this.logger.warn(
      `Event ${event.id} attempt ${newAttempts} failed, retry scheduled for ${nextRetryAt.toISOString()}`,
    );
  }
}
