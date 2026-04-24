import { IsDateString, IsNotEmpty, IsNumber, IsPositive, IsString } from 'class-validator';

export class SubmitRequestDto {
  @IsNumber()
  @IsPositive()
  employeeId: number;

  @IsString()
  @IsNotEmpty()
  locationId: string;

  @IsString()
  @IsNotEmpty()
  leaveType: string;

  @IsDateString()
  startDate: string;

  @IsDateString()
  endDate: string;
}
