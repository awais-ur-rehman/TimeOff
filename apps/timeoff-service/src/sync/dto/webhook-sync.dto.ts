import { IsNotEmpty, IsNumber, IsPositive, IsString } from 'class-validator';

export class WebhookSyncDto {
  @IsNumber()
  @IsPositive()
  employeeId: number;

  @IsString()
  @IsNotEmpty()
  locationId: string;

  @IsString()
  @IsNotEmpty()
  leaveType: string;

  @IsNumber()
  @IsPositive()
  totalDays: number;

  @IsString()
  @IsNotEmpty()
  hcmVersion: string;
}
