import { Module } from '@nestjs/common';
import { PlaybookResolverService } from './playbook-resolver.service';
import { PlaybookTemplatesService } from './playbook-templates.service';
import { PlaybooksAdminController } from './playbooks-admin.controller';

@Module({
  controllers: [PlaybooksAdminController],
  providers: [PlaybookResolverService, PlaybookTemplatesService],
  exports: [PlaybookResolverService],
})
export class PlaybooksModule {}
