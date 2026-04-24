import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import {
  HcmBalanceInsufficientException,
  HcmUnavailableException,
} from '../common/exceptions/hcm.exceptions';

export interface HcmBalanceResponse {
  totalDays: number;
  hcmVersion: string;
}

export interface HcmAllBalancesEntry {
  employeeId: number;
  locationId: string;
  leaveType: string;
  totalDays: number;
  hcmVersion: string;
}

@Injectable()
export class HcmClientService {
  private readonly logger = new Logger(HcmClientService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  private get baseUrl(): string {
    return this.configService.get<string>('HCM_BASE_URL', 'http://localhost:3001');
  }

  private get timeout(): number {
    return this.configService.get<number>('HCM_REQUEST_TIMEOUT_MS', 8000);
  }

  async deductBalance(
    employeeId: number,
    locationId: string,
    leaveType: string,
    days: number,
    idempotencyKey: string,
  ): Promise<string> {
    try {
      const response = await this.httpService.axiosRef.post(
        `${this.baseUrl}/hcm/requests`,
        { employeeId, locationId, leaveType, days },
        {
          headers: { 'x-idempotency-key': idempotencyKey },
          timeout: this.timeout,
        },
      );
      return (response.data as { hcmRequestId: string }).hcmRequestId;
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        const data = error.response.data as { hcmRequestId?: string } | undefined;
        if (data?.hcmRequestId) {
          this.logger.warn(`Duplicate HCM deduction accepted for idempotency key ${idempotencyKey}`);
          return data.hcmRequestId;
        }
      }
      this.handleHcmError(error, 'deductBalance');
    }
  }

  async reverseDeduction(hcmRequestId: string): Promise<void> {
    try {
      await this.httpService.axiosRef.delete(
        `${this.baseUrl}/hcm/requests/${hcmRequestId}`,
        { timeout: this.timeout },
      );
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        // Already reversed or never confirmed — treat as success
        this.logger.warn(`HCM request ${hcmRequestId} not found on reversal (treating as success)`);
        return;
      }
      this.handleHcmError(error, 'reverseDeduction');
    }
  }

  async getBalance(
    employeeId: number,
    locationId: string,
    leaveType: string,
  ): Promise<HcmBalanceResponse> {
    try {
      const response = await this.httpService.axiosRef.get(
        `${this.baseUrl}/hcm/balances/${employeeId}/${locationId}/${leaveType}`,
        { timeout: this.timeout },
      );
      return response.data as HcmBalanceResponse;
    } catch (error: unknown) {
      this.handleHcmError(error, 'getBalance');
    }
  }

  async getAllBalances(): Promise<HcmAllBalancesEntry[]> {
    try {
      const response = await this.httpService.axiosRef.post(
        `${this.baseUrl}/hcm/balances/batch`,
        {},
        { timeout: this.timeout },
      );
      return response.data as HcmAllBalancesEntry[];
    } catch (error: unknown) {
      this.handleHcmError(error, 'getAllBalances');
    }
  }

  private handleHcmError(error: unknown, operation: string): never {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      if (status === 422) {
        throw new HcmBalanceInsufficientException(
          `HCM rejected ${operation}: insufficient balance`,
        );
      }
      if (status !== undefined && status >= 500) {
        throw new HcmUnavailableException(
          `HCM returned ${status} during ${operation}`,
        );
      }
    }
    this.logger.error(`Unexpected error during ${operation}`, error);
    throw error;
  }
}
