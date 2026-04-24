import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, QueryResult, QueryRunner, Repository } from 'typeorm';
import { LeaveBalance } from './balance.entity';

export interface BalanceWithEffective extends LeaveBalance {
  effectiveAvailable: number;
}

export interface HcmBalanceRecord {
  employeeId: number;
  locationId: string;
  leaveType: string;
  totalDays: number;
  hcmVersion: string;
}

@Injectable()
export class BalanceService {
  private readonly logger = new Logger(BalanceService.name);

  constructor(
    @InjectRepository(LeaveBalance)
    private readonly balanceRepo: Repository<LeaveBalance>,
    private readonly dataSource: DataSource,
  ) {}

  calculateEffectiveAvailable(
    totalDays: number,
    usedDays: number,
    reservedDays: number,
  ): number {
    return Math.max(0, Number(totalDays) - Number(usedDays) - Number(reservedDays));
  }

  detectDiscrepancy(
    hcmTotal: number,
    usedDays: number,
    reservedDays: number,
  ): boolean {
    return Number(hcmTotal) < Number(usedDays) + Number(reservedDays);
  }

  async getByEmployee(employeeId: number): Promise<BalanceWithEffective[]> {
    const balances = await this.balanceRepo.find({ where: { employeeId } });
    return balances.map((b) => this.withEffective(b));
  }

  async getByEmployeeAndLocation(
    employeeId: number,
    locationId: string,
  ): Promise<BalanceWithEffective[]> {
    const balances = await this.balanceRepo.find({
      where: { employeeId, locationId },
    });
    if (balances.length === 0) {
      throw new NotFoundException(
        `No balance found for employee ${employeeId} at location ${locationId}`,
      );
    }
    return balances.map((b) => this.withEffective(b));
  }

  async upsertFromHcm(
    record: HcmBalanceRecord,
  ): Promise<{ isDiscrepancy: boolean }> {
    let balance = await this.balanceRepo.findOne({
      where: {
        employeeId: record.employeeId,
        locationId: record.locationId,
        leaveType: record.leaveType,
      },
    });

    if (!balance) {
      balance = this.balanceRepo.create({
        employeeId: record.employeeId,
        locationId: record.locationId,
        leaveType: record.leaveType,
        totalDays: record.totalDays,
        usedDays: 0,
        reservedDays: 0,
        hcmVersion: record.hcmVersion,
        lastSyncedAt: new Date(),
      });
      await this.balanceRepo.save(balance);
      return { isDiscrepancy: false };
    }

    const isDiscrepancy = this.detectDiscrepancy(
      record.totalDays,
      balance.usedDays,
      balance.reservedDays,
    );

    balance.totalDays = record.totalDays;
    balance.hcmVersion = record.hcmVersion;
    balance.lastSyncedAt = new Date();
    await this.balanceRepo.save(balance);

    return { isDiscrepancy };
  }

  /**
   * Atomic conditional UPDATE — the single place a raw query is used.
   * Returns true if the row was updated (i.e., balance was sufficient and version matched).
   */
  async reserveBalance(
    employeeId: number,
    locationId: string,
    leaveType: string,
    days: number,
    currentVersion: number,
    queryRunner: QueryRunner,
  ): Promise<boolean> {
    const result = await queryRunner.query(
      `UPDATE leave_balances
       SET reserved_days = reserved_days + ?,
           version       = version + 1
       WHERE employee_id = ?
         AND location_id = ?
         AND leave_type  = ?
         AND (total_days - used_days - reserved_days) >= ?
         AND version     = ?`,
      [days, employeeId, locationId, leaveType, days, currentVersion],
      true,
    ) as QueryResult;
    return (result.affected ?? 0) > 0;
  }

  /**
   * High-level reservation with retry loop and ConflictException after 3 misses.
   * Caller receives the committed QueryRunner transaction so it can write the request row
   * in the same atomic operation.
   */
  async reserveBalanceWithRetry(
    employeeId: number,
    locationId: string,
    leaveType: string,
    days: number,
    queryRunner: QueryRunner,
  ): Promise<void> {
    const MAX_ATTEMPTS = 3;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const balance = await queryRunner.manager.findOne(LeaveBalance, {
        where: { employeeId, locationId, leaveType },
      });

      if (!balance) {
        throw new UnprocessableEntityException(
          `No leave balance record found for employee ${employeeId}, location ${locationId}, type ${leaveType}`,
        );
      }

      const effective = this.calculateEffectiveAvailable(
        balance.totalDays,
        balance.usedDays,
        balance.reservedDays,
      );

      if (effective < days) {
        throw new UnprocessableEntityException(
          `Insufficient balance. Requested: ${days}, available: ${effective}`,
        );
      }

      const reserved = await this.reserveBalance(
        employeeId,
        locationId,
        leaveType,
        days,
        balance.version,
        queryRunner,
      );

      if (reserved) {
        return;
      }

      this.logger.warn(
        `Reserve attempt ${attempt + 1} failed (version conflict) for employee ${employeeId}`,
      );
    }

    const current = await queryRunner.manager.findOne(LeaveBalance, {
      where: { employeeId, locationId, leaveType },
    });
    const effectiveNow = current
      ? this.calculateEffectiveAvailable(
          current.totalDays,
          current.usedDays,
          current.reservedDays,
        )
      : 0;

    throw new ConflictException(
      `Balance reservation failed after ${MAX_ATTEMPTS} attempts. Current effective balance: ${effectiveNow}`,
    );
  }

  async releaseReserved(
    employeeId: number,
    locationId: string,
    leaveType: string,
    days: number,
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(
      `UPDATE leave_balances
       SET reserved_days = MAX(0, reserved_days - ?)
       WHERE employee_id = ? AND location_id = ? AND leave_type = ?`,
      [days, employeeId, locationId, leaveType],
    );
  }

  async confirmDeduction(
    employeeId: number,
    locationId: string,
    leaveType: string,
    days: number,
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(
      `UPDATE leave_balances
       SET reserved_days = MAX(0, reserved_days - ?),
           used_days     = used_days + ?
       WHERE employee_id = ? AND location_id = ? AND leave_type = ?`,
      [days, days, employeeId, locationId, leaveType],
    );
  }

  private withEffective(balance: LeaveBalance): BalanceWithEffective {
    return {
      ...balance,
      effectiveAvailable: this.calculateEffectiveAvailable(
        balance.totalDays,
        balance.usedDays,
        balance.reservedDays,
      ),
    };
  }
}
