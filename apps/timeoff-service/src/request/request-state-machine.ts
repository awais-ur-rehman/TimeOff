import { BadRequestException } from '@nestjs/common';
import { RequestStatus } from '../common/enums/request-status.enum';

const ALLOWED_TRANSITIONS: Record<RequestStatus, RequestStatus[]> = {
  [RequestStatus.PENDING]: [
    RequestStatus.APPROVED_PENDING_HCM,
    RequestStatus.REJECTED,
    RequestStatus.CANCELLED,
  ],
  [RequestStatus.APPROVED_PENDING_HCM]: [
    RequestStatus.APPROVED,
    RequestStatus.FAILED,
    RequestStatus.CANCELLED,
  ],
  [RequestStatus.APPROVED]: [RequestStatus.CANCELLED],
  [RequestStatus.REJECTED]: [],
  [RequestStatus.CANCELLED]: [],
  [RequestStatus.FAILED]: [],
};

export function canTransition(from: RequestStatus, to: RequestStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: RequestStatus, to: RequestStatus): void {
  if (!canTransition(from, to)) {
    throw new BadRequestException(
      `Cannot transition from ${from} to ${to}`,
    );
  }
}
