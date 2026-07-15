import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PlaybookResolverService } from './playbook-resolver.service';
import { PlaybookTemplatesService } from './playbook-templates.service';
import { PlaybooksAdminController } from './playbooks-admin.controller';
import { PlaybooksInternalController } from './playbooks-internal.controller';

@Module({
  imports: [AuthModule],
  controllers: [PlaybooksAdminController, PlaybooksInternalController],
  providers: [PlaybookResolverService, PlaybookTemplatesService],
  exports: [PlaybookResolverService],
})
export class PlaybooksModule {}
