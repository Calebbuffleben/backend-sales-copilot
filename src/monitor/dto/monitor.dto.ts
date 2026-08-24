import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class WhisperDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  message!: string;
}

export class SosDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  meetingId!: string;
}

export class AckAlertDto {
  @IsOptional()
  @IsString()
  alertId?: string;
}
