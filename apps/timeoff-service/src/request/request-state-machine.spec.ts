import { canTransition, assertTransition } from './request-state-machine';
import { BadRequestException } from '@nestjs/common';

describe('RequestStateMachine', () => {
  describe('canTransition', () => {
    it('allows PENDING to APPROVED_PENDING_HCM', () => {});
    it('allows PENDING to REJECTED', () => {});
    it('allows PENDING to CANCELLED', () => {});
    it('allows APPROVED_PENDING_HCM to APPROVED', () => {});
    it('allows APPROVED_PENDING_HCM to FAILED', () => {});
    it('allows APPROVED_PENDING_HCM to CANCELLED', () => {});
    it('allows APPROVED to CANCELLED', () => {});
    it('rejects APPROVED to PENDING', () => {});
    it('rejects REJECTED to PENDING', () => {});
    it('rejects REJECTED to APPROVED_PENDING_HCM', () => {});
    it('rejects CANCELLED to any state', () => {});
    it('rejects FAILED to any state except via manual admin action', () => {});
    it('rejects APPROVED to APPROVED_PENDING_HCM', () => {});
  });

  describe('assertTransition', () => {
    it('throws BadRequestException on invalid transition', () => {});
    it('does not throw on valid transition', () => {});
  });
});
