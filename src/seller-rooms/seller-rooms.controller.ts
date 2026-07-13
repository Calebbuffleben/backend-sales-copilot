import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { TenantContext } from '../tenancy/tenant-context.types';
import {
  AcceptSellerRoomInvitationDto,
  CreateSellerRoomDto,
  InviteSellerRoomMemberDto,
} from './dto/seller-rooms.dto';
import { SellerRoomsService } from './seller-rooms.service';

@Controller('seller-rooms')
export class SellerRoomsController {
  constructor(private readonly sellerRooms: SellerRoomsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() user: TenantContext | undefined,
    @Body() dto: CreateSellerRoomDto,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.sellerRooms.create(user.tenantId, user.userId, dto);
  }

  @Get()
  @SkipThrottle()
  async list(@CurrentUser() user: TenantContext | undefined) {
    if (!user) throw new UnauthorizedException();
    return this.sellerRooms.list(user.tenantId, user.userId);
  }

  @Get(':id')
  @SkipThrottle()
  async get(
    @CurrentUser() user: TenantContext | undefined,
    @Param('id') id: string,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.sellerRooms.get(user.tenantId, user.userId, id);
  }

  @Post(':id/invite')
  @HttpCode(HttpStatus.CREATED)
  async invite(
    @CurrentUser() user: TenantContext | undefined,
    @Param('id') id: string,
    @Body() dto: InviteSellerRoomMemberDto,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.sellerRooms.invite(
      user.tenantId,
      user.userId,
      id,
      dto.inviteeId,
    );
  }

  @Post('invitations/accept')
  @HttpCode(HttpStatus.OK)
  async accept(
    @CurrentUser() user: TenantContext | undefined,
    @Body() dto: AcceptSellerRoomInvitationDto,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.sellerRooms.acceptInvitation(
      user.tenantId,
      user.userId,
      dto.invitationId,
    );
  }

  @Post(':id/join')
  @HttpCode(HttpStatus.OK)
  async join(
    @CurrentUser() user: TenantContext | undefined,
    @Param('id') id: string,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.sellerRooms.join(user.tenantId, user.userId, id);
  }

  @Post(':id/leave')
  @HttpCode(HttpStatus.OK)
  async leave(
    @CurrentUser() user: TenantContext | undefined,
    @Param('id') id: string,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.sellerRooms.leave(user.tenantId, user.userId, id);
  }

  @Post(':id/end')
  @HttpCode(HttpStatus.OK)
  async end(
    @CurrentUser() user: TenantContext | undefined,
    @Param('id') id: string,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.sellerRooms.end(user.tenantId, user.userId, id);
  }
}
