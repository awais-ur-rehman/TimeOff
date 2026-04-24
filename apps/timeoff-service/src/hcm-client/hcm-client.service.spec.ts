import { HcmClientService } from './hcm-client.service';
import {
  HcmBalanceInsufficientException,
  HcmUnavailableException,
} from '../common/exceptions/hcm.exceptions';

function makeAxiosError(status: number) {
  const err = new Error(`HCM HTTP ${status}`) as Error & {
    isAxiosError: boolean;
    response: { status: number; data: unknown };
  };
  err.isAxiosError = true;
  err.response = { status, data: {} };
  return err;
}

describe('HcmClientService', () => {
  let service: HcmClientService;
  let mockAxiosRef: { post: jest.Mock; delete: jest.Mock; get: jest.Mock };

  beforeEach(() => {
    mockAxiosRef = {
      post: jest.fn(),
      delete: jest.fn(),
      get: jest.fn(),
    };

    const mockHttpService = { axiosRef: mockAxiosRef };
    const mockConfigService = {
      get: jest.fn().mockImplementation((key: string, defaultVal?: unknown) => {
        if (key === 'HCM_BASE_URL') return 'http://localhost:3099';
        if (key === 'HCM_REQUEST_TIMEOUT_MS') return 2000;
        return defaultVal;
      }),
    };

    service = new HcmClientService(
      mockHttpService as any,
      mockConfigService as any,
    );
  });

  describe('deductBalance', () => {
    it('sends correct payload with idempotency key header', async () => {
      mockAxiosRef.post.mockResolvedValue({ data: { hcmRequestId: 'hcm-001' } });

      await service.deductBalance(1, 'LOC1', 'ANNUAL', 3, 'idem-key-abc');

      expect(mockAxiosRef.post).toHaveBeenCalledWith(
        'http://localhost:3099/hcm/requests',
        { employeeId: 1, locationId: 'LOC1', leaveType: 'ANNUAL', days: 3 },
        expect.objectContaining({
          headers: { 'x-idempotency-key': 'idem-key-abc' },
        }),
      );
    });

    it('returns hcm request id on success', async () => {
      mockAxiosRef.post.mockResolvedValue({ data: { hcmRequestId: 'hcm-789' } });

      const result = await service.deductBalance(1, 'LOC1', 'ANNUAL', 3, 'key');

      expect(result).toBe('hcm-789');
    });

    it('throws HcmUnavailableException on 5xx response', async () => {
      mockAxiosRef.post.mockRejectedValue(makeAxiosError(500));

      await expect(
        service.deductBalance(1, 'LOC1', 'ANNUAL', 3, 'key'),
      ).rejects.toThrow(HcmUnavailableException);
    });

    it('throws HcmBalanceInsufficientException on 422 response', async () => {
      mockAxiosRef.post.mockRejectedValue(makeAxiosError(422));

      await expect(
        service.deductBalance(1, 'LOC1', 'ANNUAL', 3, 'key'),
      ).rejects.toThrow(HcmBalanceInsufficientException);
    });
  });

  describe('reverseDeduction', () => {
    it('calls DELETE on correct endpoint', async () => {
      mockAxiosRef.delete.mockResolvedValue({ data: {} });

      await service.reverseDeduction('hcm-req-123');

      expect(mockAxiosRef.delete).toHaveBeenCalledWith(
        'http://localhost:3099/hcm/requests/hcm-req-123',
        expect.any(Object),
      );
    });

    it('succeeds silently if HCM returns 404 (already reversed or never confirmed)', async () => {
      mockAxiosRef.delete.mockRejectedValue(makeAxiosError(404));

      await expect(service.reverseDeduction('hcm-req-404')).resolves.toBeUndefined();
    });
  });
});
