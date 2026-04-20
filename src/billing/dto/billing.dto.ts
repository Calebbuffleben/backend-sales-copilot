import { Plan } from '@prisma/client';
import { IsEnum } from 'class-validator';

export class UpgradePlanDto {
  @IsEnum(Plan)
  plan!: Plan;
}
