import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Employee } from './employee.entity';

@Injectable()
export class EmployeeService {
  constructor(
    @InjectRepository(Employee)
    private readonly employeeRepo: Repository<Employee>,
  ) {}

  async findById(id: number): Promise<Employee> {
    const employee = await this.employeeRepo.findOne({ where: { id } });
    if (!employee) {
      throw new NotFoundException(`Employee ${id} not found`);
    }
    return employee;
  }

  async findByHcmId(hcmEmployeeId: string): Promise<Employee | null> {
    return this.employeeRepo.findOne({ where: { hcmEmployeeId } });
  }

  async create(data: Omit<Employee, 'id' | 'createdAt'>): Promise<Employee> {
    const employee = this.employeeRepo.create(data);
    return this.employeeRepo.save(employee);
  }
}
