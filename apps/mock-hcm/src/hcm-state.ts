export interface BalanceRecord {
  employeeId: number;
  locationId: string;
  leaveType: string;
  totalDays: number;
  hcmVersion: string;
}

export interface DeductionRecord {
  employeeId: number;
  locationId: string;
  leaveType: string;
  days: number;
  hcmRequestId: string;
}

export class HcmState {
  readonly balances = new Map<string, BalanceRecord>();
  readonly deductions = new Map<string, DeductionRecord>();
  readonly requestIndex = new Map<string, string>();
  private requestCounter = 0;

  balanceKey(employeeId: number | string, locationId: string, leaveType: string): string {
    return `${employeeId}:${locationId}:${leaveType}`;
  }

  nextRequestId(): string {
    this.requestCounter += 1;
    return `hcm-${this.requestCounter}-${Date.now()}`;
  }

  reset(): void {
    this.balances.clear();
    this.deductions.clear();
    this.requestIndex.clear();
    this.requestCounter = 0;
  }
}
