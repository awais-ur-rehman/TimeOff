import { BadRequestException } from '@nestjs/common';
import { canTransition, assertTransition } from './request-state-machine';
import { RequestStatus } from '../common/enums/request-status.enum';

const P = RequestStatus.PENDING;
const APH = RequestStatus.APPROVED_PENDING_HCM;
const A = RequestStatus.APPROVED;
const R = RequestStatus.REJECTED;
const C = RequestStatus.CANCELLED;
const F = RequestStatus.FAILED;

describe('RequestStateMachine', () => {
  describe('canTransition', () => {
    it('allows PENDING to APPROVED_PENDING_HCM', () => {
      expect(canTransition(P, APH)).toBe(true);
    });

    it('allows PENDING to REJECTED', () => {
      expect(canTransition(P, R)).toBe(true);
    });

    it('allows PENDING to CANCELLED', () => {
      expect(canTransition(P, C)).toBe(true);
    });

    it('allows APPROVED_PENDING_HCM to APPROVED', () => {
      expect(canTransition(APH, A)).toBe(true);
    });

    it('allows APPROVED_PENDING_HCM to FAILED', () => {
      expect(canTransition(APH, F)).toBe(true);
    });

    it('allows APPROVED_PENDING_HCM to CANCELLED', () => {
      expect(canTransition(APH, C)).toBe(true);
    });

    it('allows APPROVED to CANCELLED', () => {
      expect(canTransition(A, C)).toBe(true);
    });

    it('rejects APPROVED to PENDING', () => {
      expect(canTransition(A, P)).toBe(false);
    });

    it('rejects REJECTED to PENDING', () => {
      expect(canTransition(R, P)).toBe(false);
    });

    it('rejects REJECTED to APPROVED_PENDING_HCM', () => {
      expect(canTransition(R, APH)).toBe(false);
    });

    it('rejects CANCELLED to any state', () => {
      for (const to of [P, APH, A, R, F]) {
        expect(canTransition(C, to)).toBe(false);
      }
    });

    it('rejects FAILED to any state except via manual admin action', () => {
      for (const to of [P, APH, A, R, C]) {
        expect(canTransition(F, to)).toBe(false);
      }
    });

    it('rejects APPROVED to APPROVED_PENDING_HCM', () => {
      expect(canTransition(A, APH)).toBe(false);
    });

    it('returns false when from status is not a known key (nullish fallback branch)', () => {
      expect(canTransition(undefined as any, P)).toBe(false);
    });
  });

  describe('assertTransition', () => {
    it('throws BadRequestException on invalid transition', () => {
      expect(() => assertTransition(R, P)).toThrow(BadRequestException);
    });

    it('does not throw on valid transition', () => {
      expect(() => assertTransition(P, APH)).not.toThrow();
    });
  });
});
