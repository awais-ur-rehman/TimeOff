import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, FindOptionsWhere, Repository } from 'typeorm';
import { TimeOffRequest } from './request.entity';
import { OutboxEvent, OutboxEventStatus } from '../outbox/outbox.entity';
import { LeaveBalance } from '../balance/balance.entity';
import { BalanceService } from '../balance/balance.service';
import { RequestStatus } from '../common/enums/request-status.enum';
import { OutboxEventType } from '../common/enums/outbox-event-type.enum';
import { assertTransition } from './request-state-machine';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { SubmitRequestDto } from './dto/submit-request.dto';
import { ListRequestsQueryDto } from './dto/list-requests-query.dto';

@Injectable()
export class RequestService {
  private readonly logger = new Logger(RequestService.name);

  /**
   * Per-employee serialization lock.
   * better-sqlite3 uses a singleton QueryRunner (single underlying connection),
   * so concurrent transactions nest via SAVEPOINTs and share mutable state.
   * Serializing submissions per-employee prevents interleaved reads/writes that
   * would allow both requests to see the same version and both succeed.
   */
  private readonly reservationLocks = new Map<number, Promise<void>>();

  constructor(
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,
    private readonly dataSource: DataSource,
    private readonly balanceService: BalanceService,
    @InjectRepository(OutboxEvent)
    private readonly outboxRepo: Repository<OutboxEvent>,
  ) {}

  calculateDaysRequested(startDate: string, endDate: string): number {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const msPerDay = 24 * 60 * 60 * 1000;
    return Math.round((end.getTime() - start.getTime()) / msPerDay) + 1;
  }

  async submitRequest(
    dto: SubmitRequestDto,
    caller: RequestUser,
  ): Promise<TimeOffRequest> {
    if (caller.role === 'employee' && caller.employeeId !== dto.employeeId) {
      throw new ForbiddenException('Employees can only submit requests for themselves');
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(dto.startDate);
    const end = new Date(dto.endDate);

    if (start < today) {
      throw new BadRequestException('startDate cannot be in the past');
    }
    if (end < start) {
      throw new BadRequestException('endDate must be on or after startDate');
    }

    const daysRequested = this.calculateDaysRequested(dto.startDate, dto.endDate);
    if (daysRequested <= 0) {
      throw new BadRequestException('daysRequested must be positive');
    }

    return this.withEmployeeLock(dto.employeeId, async () => {
      const qr = this.dataSource.createQueryRunner();
      await qr.connect();
      await qr.startTransaction();
      try {
        await this.balanceService.reserveBalanceWithRetry(
          dto.employeeId,
          dto.locationId,
          dto.leaveType,
          daysRequested,
          qr,
        );

        const request = qr.manager.create(TimeOffRequest, {
          employeeId: dto.employeeId,
          locationId: dto.locationId,
          leaveType: dto.leaveType,
          startDate: dto.startDate,
          endDate: dto.endDate,
          daysRequested,
          status: RequestStatus.PENDING,
        });
        const saved = await qr.manager.save(TimeOffRequest, request);
        await qr.commitTransaction();
        return saved;
      } catch (err) {
        await qr.rollbackTransaction();
        throw err;
      } finally {
        await qr.release();
      }
    });
  }

  /**
   * Serialises all balance-reservation operations for a given employee.
   * Callers queue behind the previous promise; the lock entry is cleaned up
   * once the queue drains so the Map does not grow unboundedly.
   */
  private async withEmployeeLock<T>(
    employeeId: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = this.reservationLocks.get(employeeId) ?? Promise.resolve();
    let releaseLock!: () => void;
    const next = new Promise<void>((resolve) => { releaseLock = resolve; });
    this.reservationLocks.set(employeeId, prev.then(() => next));

    await prev;
    try {
      return await fn();
    } finally {
      releaseLock();
      // Clean up the map entry once this is the last waiter.
      if (this.reservationLocks.get(employeeId) === prev.then(() => next)) {
        this.reservationLocks.delete(employeeId);
      }
    }
  }

  async approveRequest(
    id: number,
    caller: RequestUser,
  ): Promise<TimeOffRequest> {
    const request = await this.findOrFail(id);
    assertTransition(request.status, RequestStatus.APPROVED_PENDING_HCM);

    if (caller.role === 'manager' && caller.locationId !== request.locationId) {
      throw new ForbiddenException('Manager scope does not cover this request location');
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await qr.manager.update(TimeOffRequest, id, {
        status: RequestStatus.APPROVED_PENDING_HCM,
        managerId: caller.employeeId,
      });

      const outboxPayload = JSON.stringify({
        employeeId: request.employeeId,
        locationId: request.locationId,
        leaveType: request.leaveType,
        days: request.daysRequested,
      });

      const event = qr.manager.create(OutboxEvent, {
        eventType: OutboxEventType.HCM_DEDUCT,
        payload: outboxPayload,
        status: OutboxEventStatus.PENDING,
        attempts: 0,
        nextRetryAt: new Date(),
        requestId: id,
      });
      await qr.manager.save(OutboxEvent, event);

      await qr.commitTransaction();
      return this.findOrFail(id);
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  async rejectRequest(
    id: number,
    caller: RequestUser,
    reason: string,
  ): Promise<TimeOffRequest> {
    if (!reason?.trim()) {
      throw new BadRequestException('A rejection reason is required');
    }

    const request = await this.findOrFail(id);
    assertTransition(request.status, RequestStatus.REJECTED);

    if (caller.role === 'manager' && caller.locationId !== request.locationId) {
      throw new ForbiddenException('Manager scope does not cover this request location');
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await qr.manager.update(TimeOffRequest, id, {
        status: RequestStatus.REJECTED,
        rejectionReason: reason,
        managerId: caller.employeeId,
      });

      await this.balanceService.releaseReserved(
        request.employeeId,
        request.locationId,
        request.leaveType,
        Number(request.daysRequested),
        qr,
      );

      await qr.commitTransaction();
      return this.findOrFail(id);
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  async cancelRequest(id: number, caller: RequestUser): Promise<void> {
    const request = await this.findOrFail(id);

    if (caller.role === 'employee' && caller.employeeId !== request.employeeId) {
      throw new ForbiddenException('Cannot cancel another employee\'s request');
    }

    const terminalStates: RequestStatus[] = [
      RequestStatus.REJECTED,
      RequestStatus.FAILED,
      RequestStatus.CANCELLED,
    ];
    if (terminalStates.includes(request.status)) {
      throw new ConflictException(
        `Cannot cancel a request in ${request.status} state`,
      );
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      if (
        request.status === RequestStatus.APPROVED_PENDING_HCM ||
        request.status === RequestStatus.APPROVED
      ) {
        const outboxPayload = JSON.stringify({
          hcmRequestId: request.hcmRequestId,
        });
        const event = qr.manager.create(OutboxEvent, {
          eventType: OutboxEventType.HCM_REVERSE,
          payload: outboxPayload,
          status: OutboxEventStatus.PENDING,
          attempts: 0,
          nextRetryAt: new Date(),
          requestId: id,
        });
        await qr.manager.save(OutboxEvent, event);
      }

      await this.balanceService.releaseReserved(
        request.employeeId,
        request.locationId,
        request.leaveType,
        Number(request.daysRequested),
        qr,
      );

      await qr.manager.update(TimeOffRequest, id, {
        status: RequestStatus.CANCELLED,
      });

      await qr.commitTransaction();
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  async getRequest(id: number, caller: RequestUser): Promise<TimeOffRequest> {
    const request = await this.findOrFail(id);
    if (caller.role === 'employee' && caller.employeeId !== request.employeeId) {
      throw new ForbiddenException('Cannot access another employee\'s request');
    }
    return request;
  }

  async listRequests(
    query: ListRequestsQueryDto,
    caller: RequestUser,
  ): Promise<{ data: TimeOffRequest[]; nextCursor: number | null }> {
    const limit = query.limit ?? 20;
    const where: FindOptionsWhere<TimeOffRequest> = {};

    if (caller.role === 'employee') {
      where.employeeId = caller.employeeId;
    } else if (query.employeeId) {
      where.employeeId = query.employeeId;
    }
    if (query.status) where.status = query.status;
    if (query.locationId) where.locationId = query.locationId;

    const qb = this.requestRepo
      .createQueryBuilder('r')
      .where(where)
      .orderBy('r.id', 'ASC')
      .take(limit + 1);

    if (query.cursor) {
      qb.andWhere('r.id > :cursor', { cursor: query.cursor });
    }

    const results = await qb.getMany();
    const hasMore = results.length > limit;
    const data = hasMore ? results.slice(0, limit) : results;
    const nextCursor = hasMore ? data[data.length - 1].id : null;

    return { data, nextCursor };
  }

  async listTeamRequests(
    managerId: number,
    status?: RequestStatus,
  ): Promise<TimeOffRequest[]> {
    const qb = this.requestRepo.createQueryBuilder('r').orderBy('r.createdAt', 'DESC');
    if (status) qb.where('r.status = :status', { status });
    return qb.getMany();
  }

  private async findOrFail(id: number): Promise<TimeOffRequest> {
    const request = await this.requestRepo.findOne({ where: { id } });
    if (!request) {
      throw new NotFoundException(`Request ${id} not found`);
    }
    return request;
  }
}
