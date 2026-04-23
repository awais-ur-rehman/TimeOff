import axios from 'axios';

const MOCK_HCM_URL = process.env.HCM_BASE_URL || 'http://localhost:3099';

/**
 * Resets the mock HCM server's in-memory state.
 * Called in beforeEach hooks to ensure test isolation.
 */
export async function resetMockHcm(): Promise<void> {
  await axios.delete(`${MOCK_HCM_URL}/hcm/state`);
}

/**
 * Seeds a balance record directly in the mock HCM.
 */
export async function seedHcmBalance(
  employeeId: number,
  locationId: string,
  leaveType: string,
  totalDays: number,
): Promise<void> {
  await axios.post(`${MOCK_HCM_URL}/hcm/balances/seed`, {
    employeeId,
    locationId,
    leaveType,
    totalDays,
  });
}

/**
 * Simulates a work-anniversary event in the mock HCM.
 */
export async function simulateAnniversary(
  employeeId: number,
  bonusDays: number,
): Promise<void> {
  await axios.post(`${MOCK_HCM_URL}/hcm/simulate/anniversary/${employeeId}`, {
    bonusDays,
  });
}

/**
 * Sets the mock HCM error rate for failure-injection tests.
 */
export async function setHcmErrorRate(rate: number): Promise<void> {
  await axios.post(`${MOCK_HCM_URL}/hcm/simulate/error-rate`, { rate });
}
