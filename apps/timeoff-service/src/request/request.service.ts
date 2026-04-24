import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, FindOptionsWhere, QueryRunner, Repository } from 'typeorm';
import { TimeOffRequest } from './request.entity';
import { OutboxEvent, OutboxEventStatus } from '../outbox/outbox.entity';
import { BalanceService } from '../balance/balance.service';
import { RequestStatus } from '../common/enums/request-status.enum';
import { OutboxEventType } from '../common/enums/outbox-event-type.enum';
import { assertTransition } from './request-state-machine';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { SubmitRequestDto } from './dto/submit-request.dto';
import { ListRequestsQueryDto } from './dto/list-requests-query.dto';
import { Employee } from '../employee/employee.entity';

@Injectable()
export class RequestService {
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

  async submitRequest(dto: SubmitRequestDto, caller: RequestUser): Promise<TimeOffRequest> {
    if (caller.role !== 'employee' || caller.employeeId !== dto.employeeId) {
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
        await this.ensureEmployeeScope(qr.manager, dto.employeeId, caller);
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

  async approveRequest(id: number, caller: RequestUser): Promise<TimeOffRequest> {
    this.assertManagerOrAdmin(caller, 'Only managers or admins can approve requests');

    const request = await this.findOrFail(id);
    await this.ensureRequestScope(request, caller);

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const transitioned = await this.transitionRequest(
        qr.manager,
        id,
        RequestStatus.APPROVED_PENDING_HCM,
        request.version,
        { managerId: caller.employeeId },
      );

      const event = qr.manager.create(OutboxEvent, {
        eventType: OutboxEventType.HCM_DEDUCT,
        payload: JSON.stringify({
          employeeId: transitioned.employeeId,
          locationId: transitioned.locationId,
          leaveType: transitioned.leaveType,
          days: Number(transitioned.daysRequested),
        }),
        status: OutboxEventStatus.PENDING,
        attempts: 0,
        nextRetryAt: new Date(),
        requestId: transitioned.id,
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

  async rejectRequest(id: number, caller: RequestUser, reason: string): Promise<TimeOffRequest> {
    if (!reason?.trim()) {
      throw new BadRequestException('A rejection reason is required');
    }
    this.assertManagerOrAdmin(caller, 'Only managers or admins can reject requests');

    const request = await this.findOrFail(id);
    await this.ensureRequestScope(request, caller);

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await this.transitionRequest(
        qr.manager,
        id,
        RequestStatus.REJECTED,
        request.version,
        {
          rejectionReason: reason,
          managerId: caller.employeeId,
        },
      );

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
    await this.ensureRequestScope(request, caller);

    if (
      request.status === RequestStatus.APPROVED ||
      request.status === RequestStatus.REJECTED ||
      request.status === RequestStatus.FAILED ||
      request.status === RequestStatus.CANCELLED
    ) {
      throw new ConflictException(`Cannot cancel a request in ${request.status} state`);
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      if (request.status === RequestStatus.APPROVED_PENDING_HCM) {
        const event = qr.manager.create(OutboxEvent, {
          eventType: OutboxEventType.HCM_REVERSE,
          payload: JSON.stringify({}),
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
      await this.transitionRequest(
        qr.manager,
        id,
        RequestStatus.CANCELLED,
        request.version,
      );

      await qr.commitTransaction();
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  async completeDeductionFromOutbox(
    queryRunner: QueryRunner,
    requestId: number,
    hcmRequestId: string,
  ): Promise<TimeOffRequest> {
    const request = await this.findOrFail(requestId, queryRunner.manager);

    // Already completed (idempotent replay)
    if (request.status === RequestStatus.APPROVED) {
      return request;
    }

    // Request was cancelled while APPROVED_PENDING_HCM — store hcmRequestId for reversal
    if (request.status === RequestStatus.CANCELLED) {
      await queryRunner.manager.update(TimeOffRequest, requestId, { hcmRequestId });
      return this.findOrFail(requestId, queryRunner.manager);
    }

    // Normal path (APPROVED_PENDING_HCM → APPROVED) or recovery (FAILED → APPROVED)
    const updatedRequest = await this.transitionRequest(
      queryRunner.manager,
      requestId,
      RequestStatus.APPROVED,
      request.version,
      { hcmRequestId },
    );

    await this.balanceService.confirmDeduction(
      updatedRequest.employeeId,
      updatedRequest.locationId,
      updatedRequest.leaveType,
      Number(updatedRequest.daysRequested),
      queryRunner,
    );

    return updatedRequest;
  }

  async failRequestFromOutbox(queryRunner: QueryRunner, requestId: number): Promise<TimeOffRequest> {
    const request = await this.findOrFail(requestId, queryRunner.manager);

    // Already in a terminal state — nothing to do
    if (
      request.status === RequestStatus.FAILED ||
      request.status === RequestStatus.CANCELLED ||
      request.status === RequestStatus.APPROVED
    ) {
      return request;
    }

    return this.transitionRequest(
      queryRunner.manager,
      requestId,
      RequestStatus.FAILED,
      request.version,
    );
  }

  async getRequest(id: number, caller: RequestUser): Promise<TimeOffRequest> {
    const request = await this.findOrFail(id);
    await this.ensureRequestScope(request, caller);
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
    } else if (caller.role === 'manager') {
      where.locationId = caller.locationId;
      if (query.employeeId) {
        const employee = await this.findEmployeeOrFail(query.employeeId);
        if (employee.locationId !== caller.locationId) {
          throw new ForbiddenException('Manager scope does not cover this employee');
        }
        where.employeeId = query.employeeId;
      }
    } else if (query.employeeId) {
      where.employeeId = query.employeeId;
    }

    if (query.status) {
      where.status = query.status;
    }
    if (query.locationId) {
      if (caller.role === 'manager' && caller.locationId !== query.locationId) {
        throw new ForbiddenException('Manager scope does not cover this location');
      }
      where.locationId = query.locationId;
    }

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
    caller: RequestUser,
    status?: RequestStatus,
  ): Promise<Array<TimeOffRequest & { employeeName: string; effectiveAvailableAtSubmission: number }>> {
    this.assertManagerOrAdmin(caller, 'Only managers or admins can view team requests');

    const qb = this.requestRepo
      .createQueryBuilder('r')
      .innerJoin(Employee, 'e', 'e.id = r.employee_id')
      .innerJoin(
        'leave_balances',
        'b',
        'b.employee_id = r.employee_id AND b.location_id = r.location_id AND b.leave_type = r.leave_type',
      )
      .select('r.id', 'id')
      .addSelect('r.employee_id', 'employeeId')
      .addSelect('r.location_id', 'locationId')
      .addSelect('r.leave_type', 'leaveType')
      .addSelect('r.start_date', 'startDate')
      .addSelect('r.end_date', 'endDate')
      .addSelect('r.days_requested', 'daysRequested')
      .addSelect('r.status', 'status')
      .addSelect('r.manager_id', 'managerId')
      .addSelect('r.rejection_reason', 'rejectionReason')
      .addSelect('r.hcm_request_id', 'hcmRequestId')
      .addSelect('r.version', 'version')
      .addSelect('r.created_at', 'createdAt')
      .addSelect('r.updated_at', 'updatedAt')
      .addSelect('e.name', 'employeeName')
      .addSelect('(b.total_days - b.used_days - b.reserved_days)', 'effectiveAvailableAtSubmission')
      .orderBy('r.created_at', 'DESC');

    if (caller.role === 'manager') {
      qb.where('r.location_id = :locationId', { locationId: caller.locationId });
    }
    if (status) {
      qb.andWhere('r.status = :status', { status });
    }

    const rows = await qb.getRawMany<
      TimeOffRequest & { employeeName: string; effectiveAvailableAtSubmission: number }
    >();

    return rows.map((row) => ({
      id: Number(row.id),
      employeeId: Number(row.employeeId),
      locationId: row.locationId,
      leaveType: row.leaveType,
      startDate: row.startDate,
      endDate: row.endDate,
      daysRequested: Number(row.daysRequested),
      status: row.status,
      managerId: row.managerId ? Number(row.managerId) : null,
      rejectionReason: row.rejectionReason,
      hcmRequestId: row.hcmRequestId,
      version: Number(row.version),
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
      employeeName: row.employeeName,
      effectiveAvailableAtSubmission: Number(row.effectiveAvailableAtSubmission),
    }));
  }

  private async withEmployeeLock<T>(employeeId: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.reservationLocks.get(employeeId) ?? Promise.resolve();
    let releaseLock!: () => void;
    const next = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const lock = prev.then(() => next);
    this.reservationLocks.set(employeeId, lock);

    await prev;
    try {
      return await fn();
    } finally {
      releaseLock();
      if (this.reservationLocks.get(employeeId) === lock) {
        this.reservationLocks.delete(employeeId);
      }
    }
  }

  private async transitionRequest(
    manager: EntityManager,
    id: number,
    to: RequestStatus,
    expectedVersion: number,
    extraFields: Partial<TimeOffRequest> = {},
  ): Promise<TimeOffRequest> {
    const current = await this.findOrFail(id, manager);
    assertTransition(current.status, to);

    const result = await manager
      .createQueryBuilder()
      .update(TimeOffRequest)
      .set({
        ...extraFields,
        status: to,
        version: () => 'version + 1',
      })
      .where('id = :id', { id })
      .andWhere('version = :expectedVersion', { expectedVersion })
      .execute();

    if ((result.affected ?? 0) === 0) {
      throw new ConflictException(`Request ${id} was modified concurrently`);
    }

    return this.findOrFail(id, manager);
  }

  private async ensureRequestScope(request: TimeOffRequest, caller: RequestUser): Promise<void> {
    if (caller.role === 'admin') {
      return;
    }
    if (caller.role === 'manager') {
      if (!caller.locationId || caller.locationId !== request.locationId) {
        throw new ForbiddenException('Manager scope does not cover this request location');
      }
      return;
    }
    if (caller.employeeId !== request.employeeId) {
      throw new ForbiddenException('Employees can only access their own requests');
    }
  }

  private async ensureEmployeeScope(
    manager: EntityManager,
    employeeId: number,
    caller: RequestUser,
  ): Promise<void> {
    if (caller.role === 'admin') {
      return;
    }
    const employee = await this.findEmployeeOrFail(employeeId, manager);
    if (caller.role === 'manager') {
      if (!caller.locationId || caller.locationId !== employee.locationId) {
        throw new ForbiddenException('Manager scope does not cover this employee');
      }
      return;
    }
    if (caller.employeeId !== employeeId) {
      throw new ForbiddenException('Employees can only access their own requests');
    }
  }

  private assertManagerOrAdmin(caller: RequestUser, message: string): void {
    if (caller.role !== 'manager' && caller.role !== 'admin') {
      throw new ForbiddenException(message);
    }
  }

  private async findEmployeeOrFail(
    employeeId: number,
    manager: EntityManager = this.requestRepo.manager,
  ): Promise<Employee> {
    const employee = await manager.findOne(Employee, { where: { id: employeeId } });
    if (!employee) {
      throw new NotFoundException(`Employee ${employeeId} not found`);
    }
    return employee;
  }

  private async findOrFail(
    id: number,
    manager: EntityManager = this.requestRepo.manager,
  ): Promise<TimeOffRequest> {
    const request = await manager.findOne(TimeOffRequest, { where: { id } });
    if (!request) {
      throw new NotFoundException(`Request ${id} not found`);
    }
    return request;
  }
}
