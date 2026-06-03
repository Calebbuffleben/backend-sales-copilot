import {
  InviteStatus,
  MembershipRole,
  TenantStatus,
} from '@prisma/client';
import {
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class PlatformListQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class TenantListQueryDto extends PlatformListQueryDto {
  @IsOptional()
  @IsEnum(TenantStatus)
  status?: TenantStatus;
}

export class UpdateTenantDto {
  @IsOptional()
  @IsEnum(TenantStatus)
  status?: TenantStatus;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;
}

export class UserListQueryDto extends PlatformListQueryDto {
  @IsOptional()
  @IsString()
  tenantId?: string;

  @IsOptional()
  @IsEnum(MembershipRole)
  role?: MembershipRole;
}

export class InviteListQueryDto extends PlatformListQueryDto {
  @IsOptional()
  @IsString()
  tenantId?: string;

  @IsOptional()
  @IsEnum(InviteStatus)
  status?: InviteStatus;
}

export class CreatePlatformInvitationDto {
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsEnum(MembershipRole)
  role?: MembershipRole;
}
