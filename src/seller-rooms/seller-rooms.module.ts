import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { FingerprintCacheService } from './fingerprint-cache';
import { FingerprintSyncGateway } from './fingerprint-sync.gateway';
import { SellerAudioFingerprintService } from './seller-audio-fingerprint.service';
import { SellerRoomsController } from './seller-rooms.controller';
import { SellerRoomsService } from './seller-rooms.service';

@Module({
  imports: [AuthModule],
  controllers: [SellerRoomsController],
  providers: [
    SellerRoomsService,
    FingerprintCacheService,
    SellerAudioFingerprintService,
    FingerprintSyncGateway,
  ],
  exports: [SellerRoomsService, FingerprintCacheService, FingerprintSyncGateway],
})
export class SellerRoomsModule {}
