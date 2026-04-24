import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HcmState, BalanceRecord, DeductionRecord } from './hcm-state';

@Injectable()
export class HcmService {
  readonly state = new HcmState();

  constructor(private readonly config: ConfigService) {}

  private get errorRate(): number {
    return this.config.get<number>('HCM_ERROR_RATE', 0);
  }

  shouldSimulateError(): boolean {
    return Math.random() < this.errorRate;
  }

  getBalance(employeeId: string, locationId: string, leaveType: string): BalanceRecord {
    const key = this.state.balanceKey(employeeId, locationId, leaveType);
    const record = this.state.balances.get(key);
    if (!record) throw new NotFoundException('Balance not found');
    return record;
  }

  getAllBalances(): BalanceRecord[] {
    return Array.from(this.state.balances.values());
  }

  seedBalance(
    employeeId: number,
    locationId: string,
    leaveType: string,
    totalDays: number,
  ): void {
    const key = this.state.balanceKey(employeeId, locationId, leaveType);
    this.state.balances.set(key, {
      employeeId,
      locationId,
      leaveType,
      totalDays,
      hcmVersion: '1',
    });
  }

  deductBalance(
    employeeId: number,
    locationId: string,
    leaveType: string,
    days: number,
    idempotencyKey: string | undefined,
  ): { hcmRequestId: string; statusCode: 200 | 201 } {
    if (idempotencyKey && this.state.deductions.has(idempotencyKey)) {
      const existing = this.state.deductions.get(idempotencyKey)!;
      return { hcmRequestId: existing.hcmRequestId, statusCode: 200 };
    }

    const key = this.state.balanceKey(employeeId, locationId, leaveType);
    const balance = this.state.balances.get(key);
    if (!balance) {
      throw new NotFoundException('Balance not found');
    }
    if (balance.totalDays < days) {
      throw new UnprocessableEntityException('Insufficient balance');
    }

    const hcmRequestId = this.state.nextRequestId();
    const record: DeductionRecord = { employeeId, locationId, leaveType, days, hcmRequestId };
    this.state.balances.set(key, {
      ...balance,
      totalDays: balance.totalDays - days,
      hcmVersion: String(Number(balance.hcmVersion) + 1),
    });

    if (idempotencyKey) this.state.deductions.set(idempotencyKey, record);
    this.state.requestIndex.set(hcmRequestId, idempotencyKey ?? hcmRequestId);

    return { hcmRequestId, statusCode: 201 };
  }

  reverseDeduction(hcmRequestId: string): void {
    const idemKey = this.state.requestIndex.get(hcmRequestId);
    if (!idemKey) throw new NotFoundException('HCM request not found');
    const deduction = this.state.deductions.get(idemKey);
    if (deduction) {
      const key = this.state.balanceKey(
        deduction.employeeId,
        deduction.locationId,
        deduction.leaveType,
      );
      const balance = this.state.balances.get(key);
      if (!balance) {
        throw new NotFoundException('Balance not found');
      }
      this.state.balances.set(key, {
        ...balance,
        totalDays: balance.totalDays + deduction.days,
        hcmVersion: String(Number(balance.hcmVersion) + 1),
      });
    }
    this.state.deductions.delete(idemKey);
    this.state.requestIndex.delete(hcmRequestId);
  }

  getDeduction(hcmRequestId: string): { hcmRequestId: string } {
    if (!this.state.requestIndex.has(hcmRequestId)) {
      throw new NotFoundException('HCM request not found');
    }
    return { hcmRequestId };
  }

  simulateAnniversary(employeeId: string, bonusDays: number): void {
    for (const [key, record] of this.state.balances.entries()) {
      if (key.startsWith(`${employeeId}:`)) {
        this.state.balances.set(key, {
          ...record,
          totalDays: record.totalDays + bonusDays,
          hcmVersion: String(Number(record.hcmVersion) + 1),
        });
      }
    }
  }

  reset(): void {
    this.state.reset();
  }
}
