import { BalanceService } from './balance.service';

describe('BalanceService', () => {
  let service: BalanceService;

  beforeEach(() => {
    service = new BalanceService(null as any, null as any);
  });

  describe('calculateEffectiveAvailable', () => {
    it('returns total minus used minus reserved', () => {
      expect(service.calculateEffectiveAvailable(10, 3, 2)).toBe(5);
    });

    it('returns 0 when reserved plus used equals total', () => {
      expect(service.calculateEffectiveAvailable(10, 5, 5)).toBe(0);
    });

    it('returns 0 when reserved plus used exceeds total (clamp at zero)', () => {
      expect(service.calculateEffectiveAvailable(10, 7, 5)).toBe(0);
    });

    it('handles decimal values correctly', () => {
      expect(service.calculateEffectiveAvailable(10.5, 2.5, 3.0)).toBeCloseTo(5.0);
    });
  });

  describe('detectDiscrepancy', () => {
    it('returns true when hcm total is less than used plus reserved', () => {
      expect(service.detectDiscrepancy(8, 5, 5)).toBe(true);
    });

    it('returns false when hcm total equals used plus reserved', () => {
      expect(service.detectDiscrepancy(10, 5, 5)).toBe(false);
    });

    it('returns false when hcm total is greater than used plus reserved', () => {
      expect(service.detectDiscrepancy(15, 5, 5)).toBe(false);
    });
  });
});
