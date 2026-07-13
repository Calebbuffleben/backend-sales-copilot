import {
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateSellerRoomDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  meetingId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  meetUrl?: string;
}

export class InviteSellerRoomMemberDto {
  @IsEmail()
  email!: string;
}

export class AcceptSellerRoomInvitationDto {
  @IsUUID()
  invitationId!: string;
}
