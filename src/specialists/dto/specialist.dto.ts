import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const SPIN_PHASES = [
  'neutro',
  'situacao',
  'problema',
  'implicacao',
  'necessidade',
] as const;

export class UpsertSpecialistDto {
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  @Matches(/^[a-z0-9_]+$/, {
    message: 'key must be lowercase alphanumeric with underscores',
  })
  key!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  instructions?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  tone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  exampleMessage?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsIn(SPIN_PHASES, { each: true })
  triggerPhases?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  triggerKeywords?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  minConfidence?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(300)
  cooldownSec?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1000)
  priority?: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  model?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(200)
  @Max(15000)
  maxLatencyMs?: number;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  icon?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  color?: string;
}

export class PatchSpecialistDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  instructions?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  tone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  exampleMessage?: string;

  @IsOptional()
  @IsArray()
  @IsIn(SPIN_PHASES, { each: true })
  triggerPhases?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  triggerKeywords?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  minConfidence?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  cooldownSec?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  priority?: number;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  maxLatencyMs?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  icon?: string;

  @IsOptional()
  @IsString()
  color?: string;
}

export class DryRunSpecialistDto {
  @IsString()
  @MinLength(8)
  @MaxLength(8000)
  transcript!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  hostContext?: string;
}

export class RegisterBuiltinSpecialistDto {
  @IsString()
  @Matches(/^[a-z0-9_]+$/)
  key!: string;

  @IsString()
  @MinLength(2)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  instructions?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  triggerPhases?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  triggerKeywords?: string[];

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  maxLatencyMs?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  priority?: number;
}

export class SaveSpecialistPreferenceDto {
  @IsArray()
  @ArrayMaxSize(32)
  @IsString({ each: true })
  specialistKeys!: string[];
}
