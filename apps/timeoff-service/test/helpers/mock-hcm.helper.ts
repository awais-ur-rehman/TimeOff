import axios from 'axios';

const MOCK_HCM_URL = process.env.HCM_BASE_URL || 'http://localhost:3099';

export async function resetMockHcm(): Promise<void> {
  await axios.delete(`${MOCK_HCM_URL}/hcm/state`);
}

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

export async function simulateAnniversary(
  employeeId: number,
  bonusDays: number,
): Promise<void> {
  await axios.post(`${MOCK_HCM_URL}/hcm/simulate/anniversary/${employeeId}`, {
    bonusDays,
  });
}

export async function setHcmErrorRate(rate: number): Promise<void> {
  await axios.post(`${MOCK_HCM_URL}/hcm/simulate/error-rate`, { rate });
}
