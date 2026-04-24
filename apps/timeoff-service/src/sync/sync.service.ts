import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { Repository, DataSource, LessThan, In } from 'typeorm';
import { LeaveBalance } from '../balance/balance.entity';
import { TimeOffRequest } from '../request/request.entity';
import { OutboxEvent, OutboxEventStatus } from '../outbox/outbox.entity';
import { SyncLog, SyncLogStatus, SyncType } from './sync-log.entity';
import { BalanceService } from '../balance/balance.service';
import { HcmClientService } from '../hcm-client/hcm-client.service';
import { RequestStatus } from '../common/enums/request-status.enum';

export interface BatchRecord {
  employeeId: number;
  locationId: string;
  leaveType: string;
  totalDays: number;
  hcmVersion: string;
}

export interface SyncStatusDto {
  lastBatchSyncAt: Date | null;
  lastWebhookAt: Date | null;
  outboxQueueDepth: Record<string, number>;
  failedEvents: number;
}

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    @InjectRepository(LeaveBalance)
    private readonly balanceRepo: Repository<LeaveBalance>,
    @InjectRepository(SyncLog)
    private readonly syncLogRepo: Repository<SyncLog>,
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,
    @InjectRepository(OutboxEvent)
    private readonly outboxRepo: Repository<OutboxEvent>,
    private readonly balanceService: BalanceService,
    private readonly hcmClient: HcmClientService,
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {}

  @Cron(process.env.RECONCILIATION_CRON || '*/15 * * * *')
  async handleScheduledReconciliation(): Promise<void> {
    try {
      await this.triggerReconciliation();
    } catch (err) {
      this.logger.error('Scheduled reconciliation failed', err);
    }
  }

  async processBatchPayload(
    records: BatchRecord[],
  ): Promise<{ recordsProcessed: number; discrepancies: number }> {
    const log = await this.syncLogRepo.save(
      this.syncLogRepo.create({
        syncType: SyncType.BATCH,
        triggeredBy: 'SYSTEM',
        status: SyncLogStatus.STARTED,
        startedAt: new Date(),
      }),
    );

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      let discrepancies = 0;

      for (const record of records) {
        let balance = await qr.manager.findOne(LeaveBalance, {
          where: {
            employeeId: record.employeeId,
            locationId: record.locationId,
            leaveType: record.leaveType,
          },
        });

        if (!balance) {
          balance = qr.manager.create(LeaveBalance, {
            employeeId: record.employeeId,
            locationId: record.locationId,
            leaveType: record.leaveType,
            totalDays: record.totalDays,
            usedDays: 0,
            reservedDays: 0,
            hcmVersion: record.hcmVersion,
            lastSyncedAt: new Date(),
          });
          await qr.manager.save(LeaveBalance, balance);
        } else {
          const isDiscrepancy = this.balanceService.detectDiscrepancy(
            record.totalDays,
            balance.usedDays,
            balance.reservedDays,
          );
          if (isDiscrepancy) {
            discrepancies += 1;
            this.logger.warn(
              `Discrepancy for employee ${record.employeeId}: HCM total ${record.totalDays} < used(${balance.usedDays}) + reserved(${balance.reservedDays})`,
            );
            await this.flagActiveRequests(record.employeeId, qr);
          }

          balance.totalDays = record.totalDays;
          balance.hcmVersion = record.hcmVersion;
          balance.lastSyncedAt = new Date();
          await qr.manager.save(LeaveBalance, balance);
        }
      }

      await qr.commitTransaction();

      await this.syncLogRepo.update(log.id, {
        status: SyncLogStatus.DONE,
        recordsProcessed: records.length,
        discrepancies,
        completedAt: new Date(),
      });

      this.logger.log(`Batch sync done: ${records.length} records, ${discrepancies} discrepancies`);
      return { recordsProcessed: records.length, discrepancies };
    } catch (err: unknown) {
      await qr.rollbackTransaction();
      await this.syncLogRepo.update(log.id, {
        status: SyncLogStatus.FAILED,
        errorDetail: err instanceof Error ? err.message : String(err),
        completedAt: new Date(),
      });
      throw err;
    } finally {
      await qr.release();
    }
  }

  async processWebhookPayload(payload: BatchRecord): Promise<void> {
    const balance = await this.balanceRepo.findOne({
      where: {
        employeeId: payload.employeeId,
        locationId: payload.locationId,
        leaveType: payload.leaveType,
      },
    });

    if (!balance) {
      throw new NotFoundException(
        `No balance found for employee ${payload.employeeId} at ${payload.locationId}/${payload.leaveType}`,
      );
    }

    const isDiscrepancy = this.balanceService.detectDiscrepancy(
      payload.totalDays,
      balance.usedDays,
      balance.reservedDays,
    );

    balance.totalDays = payload.totalDays;
    balance.hcmVersion = payload.hcmVersion;
    balance.lastSyncedAt = new Date();
    await this.balanceRepo.save(balance);

    const log = await this.syncLogRepo.save(
      this.syncLogRepo.create({
        syncType: SyncType.WEBHOOK,
        triggeredBy: 'SYSTEM',
        status: SyncLogStatus.DONE,
        recordsProcessed: 1,
        discrepancies: isDiscrepancy ? 1 : 0,
        startedAt: new Date(),
        completedAt: new Date(),
      }),
    );

    if (isDiscrepancy) {
      this.logger.warn(
        `Webhook discrepancy for employee ${payload.employeeId}: new total ${payload.totalDays} < used(${balance.usedDays}) + reserved(${balance.reservedDays})`,
      );
      const qr = this.dataSource.createQueryRunner();
      await qr.connect();
      try {
        await this.flagActiveRequests(payload.employeeId, qr);
      } finally {
        await qr.release();
      }
    }

    this.logger.log(`Webhook sync done for employee ${payload.employeeId}`);
  }

  async triggerReconciliation(): Promise<{ recordsProcessed: number }> {
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);

    // Find balances that are stale OR belong to employees with active requests
    const staleBalances = await this.balanceRepo.find({
      where: [
        { lastSyncedAt: LessThan(thirtyMinutesAgo) },
      ],
    });

    // Also find employees with active requests
    const activeRequests = await this.requestRepo.find({
      where: { status: In([RequestStatus.PENDING, RequestStatus.APPROVED_PENDING_HCM]) },
    });
    const activeEmployeeIds = [...new Set(activeRequests.map((r) => r.employeeId))];

    if (activeEmployeeIds.length > 0) {
      const activeBalances = await this.balanceRepo.find({
        where: activeEmployeeIds.map((id) => ({ employeeId: id })),
      });
      for (const b of activeBalances) {
        if (!staleBalances.find((s) => s.id === b.id)) {
          staleBalances.push(b);
        }
      }
    }

    const log = await this.syncLogRepo.save(
      this.syncLogRepo.create({
        syncType: SyncType.SCHEDULED,
        triggeredBy: 'SYSTEM',
        status: SyncLogStatus.STARTED,
        startedAt: new Date(),
      }),
    );

    let processed = 0;
    let discrepancies = 0;

    for (const balance of staleBalances) {
      try {
        const hcmData = await this.hcmClient.getBalance(
          balance.employeeId,
          balance.locationId,
          balance.leaveType,
        );

        const isDiscrepancy = this.balanceService.detectDiscrepancy(
          hcmData.totalDays,
          balance.usedDays,
          balance.reservedDays,
        );
        if (isDiscrepancy) discrepancies += 1;

        balance.totalDays = hcmData.totalDays;
        balance.hcmVersion = hcmData.hcmVersion;
        balance.lastSyncedAt = new Date();
        await this.balanceRepo.save(balance);
        processed += 1;
      } catch (err: unknown) {
        this.logger.error(
          `Reconciliation failed for balance ${balance.id}`,
          err,
        );
      }
    }

    await this.syncLogRepo.update(log.id, {
      status: SyncLogStatus.DONE,
      recordsProcessed: processed,
      discrepancies,
      completedAt: new Date(),
    });

    this.logger.log(`Reconciliation done: ${processed} records updated`);
    return { recordsProcessed: processed };
  }

  async getSyncStatus(): Promise<SyncStatusDto> {
    const lastBatch = await this.syncLogRepo.findOne({
      where: { syncType: SyncType.BATCH, status: SyncLogStatus.DONE },
      order: { completedAt: 'DESC' },
    });

    const lastWebhook = await this.syncLogRepo.findOne({
      where: { syncType: SyncType.WEBHOOK, status: SyncLogStatus.DONE },
      order: { completedAt: 'DESC' },
    });

    const statuses = Object.values(OutboxEventStatus);
    const depthByStatus: Record<string, number> = {};
    for (const status of statuses) {
      depthByStatus[status] = await this.outboxRepo.count({ where: { status } });
    }

    return {
      lastBatchSyncAt: lastBatch?.completedAt ?? null,
      lastWebhookAt: lastWebhook?.completedAt ?? null,
      outboxQueueDepth: depthByStatus,
      failedEvents: depthByStatus[OutboxEventStatus.FAILED] ?? 0,
    };
  }

  private async flagActiveRequests(
    employeeId: number,
    qr: { manager: { find: (entity: unknown, opts: unknown) => Promise<TimeOffRequest[]> } },
  ): Promise<void> {
    const active = await qr.manager.find(TimeOffRequest, {
      where: [
        { employeeId, status: RequestStatus.PENDING },
        { employeeId, status: RequestStatus.APPROVED_PENDING_HCM },
      ],
    });
    if (active.length > 0) {
      this.logger.warn(
        `Flagging ${active.length} active request(s) for employee ${employeeId} due to balance discrepancy: ids=[${active.map((r) => r.id).join(', ')}]`,
      );
    }
  }
}
