import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('employees')
export class Employee {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  hcmEmployeeId: string;

  @Column()
  name: string;

  @Column()
  locationId: string;

  @CreateDateColumn()
  createdAt: Date;
}
