import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, LessThanOrEqual, QueryResult, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { OutboxEvent, OutboxEventStatus } from './outbox.entity';
import { HcmClientService } from '../hcm-client/hcm-client.service';
import { OutboxEventType } from '../common/enums/outbox-event-type.enum';

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
  ) {}

  onModuleInit(): void {
    const intervalMs = this.configService.get<number>('OUTBOX_POLL_INTERVAL_MS', 5000);
    this.intervalHandle = setInterval(() => {
      this.tick().catch((err: unknown) =>
        this.logger.error('Outbox tick error', err),
      );
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

    if (events.length === 0) return;

    await this.outboxRepo
      .createQueryBuilder()
      .update()
      .set({ status: OutboxEventStatus.PROCESSING })
      .whereInIds(events.map((e) => e.id))
      .execute();

    for (const event of events) {
      await this.processEvent(event);
    }
  }

  private async processEvent(event: OutboxEvent): Promise<void> {
    try {
      const payload = JSON.parse(event.payload) as DeductPayload & { hcmRequestId?: string };

      if (event.eventType === OutboxEventType.HCM_DEDUCT) {
        await this.processDeductEvent(event, payload);
      } else if (event.eventType === OutboxEventType.HCM_REVERSE) {
        await this.processReverseEvent(event);
      }
    } catch (error: unknown) {
      this.logger.error(`Outbox event ${event.id} (${event.eventType}) failed`, error);
      await this.handleEventFailure(event);
    }
  }

  private async processDeductEvent(event: OutboxEvent, payload: DeductPayload): Promise<void> {
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
      await qr.query(
        'UPDATE time_off_requests SET hcm_request_id = ? WHERE id = ?',
        [hcmRequestId, event.requestId],
      );

      const result = await qr.query(
        `UPDATE time_off_requests
         SET status = 'APPROVED', updated_at = datetime('now')
         WHERE id = ? AND status = 'APPROVED_PENDING_HCM'`,
        [event.requestId],
        true,
      ) as QueryResult;

      if ((result.affected ?? 0) > 0) {
        await qr.query(
          `UPDATE leave_balances
           SET reserved_days = MAX(0, reserved_days - ?),
               used_days     = used_days + ?
           WHERE employee_id = ? AND location_id = ? AND leave_type = ?`,
          [payload.days, payload.days, payload.employeeId, payload.locationId, payload.leaveType],
        );
      }

      await qr.query(
        'UPDATE outbox_events SET status = ? WHERE id = ?',
        [OutboxEventStatus.DONE, event.id],
      );

      await qr.commitTransaction();
      this.logger.log(`Event ${event.id} DONE — request ${event.requestId} hcmRequestId=${hcmRequestId}`);
    } catch (dbErr) {
      await qr.rollbackTransaction();
      await this.outboxRepo.update(event.id, { status: OutboxEventStatus.PENDING });
      throw dbErr;
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
      throw new Error(
        `hcm_request_id not yet set on request ${event.requestId} — retrying`,
      );
    }

    await this.hcmClient.reverseDeduction(hcmRequestId);
    await this.outboxRepo.update(event.id, { status: OutboxEventStatus.DONE });
    this.logger.log(`Event ${event.id} HCM_REVERSE DONE — reversed ${hcmRequestId}`);
  }

  private async handleEventFailure(event: OutboxEvent): Promise<void> {
    const newAttempts = event.attempts + 1;

    if (this.shouldMarkFailed(newAttempts)) {
      await this.outboxRepo.update(event.id, {
        status: OutboxEventStatus.FAILED,
        attempts: newAttempts,
      });
      await this.dataSource.query(
        `UPDATE time_off_requests
         SET status = 'FAILED', updated_at = datetime('now')
         WHERE id = ? AND status = 'APPROVED_PENDING_HCM'`,
        [event.requestId],
      );
      this.logger.error(
        `Event ${event.id} exhausted all retries — request ${event.requestId} marked FAILED`,
      );
    } else {
      await this.outboxRepo.update(event.id, {
        status: OutboxEventStatus.PENDING,
        attempts: newAttempts,
        nextRetryAt: null,
      });
      this.logger.warn(`Event ${event.id} attempt ${newAttempts} failed, will retry on next tick`);
    }
  }
}
