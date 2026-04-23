export interface RequestUser {
  employeeId: number;
  role: 'employee' | 'manager' | 'admin';
  locationId?: string;
}
