import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import {
  PLAYBOOK_MAX_ACTION_PAYLOAD_CHARS,
  PLAYBOOK_MAX_STEP_DETAIL_CHARS,
  PLAYBOOK_MAX_STEP_ID_CHARS,
  PLAYBOOK_MAX_STEP_LABEL_CHARS,
  PLAYBOOK_MAX_STEPS,
  PLAYBOOK_MAX_TEMPLATE_KEY_CHARS,
  PLAYBOOK_MAX_TITLE_CHARS,
} from '../playbook-metadata.contract';

const ACTION_TYPES = ['copy_text', 'open_url', 'noop'] as const;

export class PlaybookActionDto {
  @IsIn(ACTION_TYPES)
  type!: (typeof ACTION_TYPES)[number];

  @ValidateIf(
    (o: PlaybookActionDto) => o.type === 'copy_text' || o.type === 'open_url',
  )
  @IsNotEmpty()
  @IsString()
  @MaxLength(PLAYBOOK_MAX_ACTION_PAYLOAD_CHARS)
  payload?: string;
}

export class PlaybookStepDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(PLAYBOOK_MAX_STEP_ID_CHARS)
  id!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(PLAYBOOK_MAX_STEP_LABEL_CHARS)
  label!: string;

  @IsOptional()
  @IsString()
  @MaxLength(PLAYBOOK_MAX_STEP_DETAIL_CHARS)
  detail?: string;

  @ValidateNested()
  @Type(() => PlaybookActionDto)
  action!: PlaybookActionDto;
}

export class CreatePlaybookTemplateDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-zA-Z0-9_-]+$/, {
    message: 'key must be alphanumeric with underscores or hyphens',
  })
  @MaxLength(PLAYBOOK_MAX_TEMPLATE_KEY_CHARS)
  key!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(PLAYBOOK_MAX_TITLE_CHARS)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(PLAYBOOK_MAX_STEPS)
  @ValidateNested({ each: true })
  @Type(() => PlaybookStepDto)
  steps!: PlaybookStepDto[];
}

export class UpdatePlaybookTemplateDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(PLAYBOOK_MAX_TITLE_CHARS)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(PLAYBOOK_MAX_STEPS)
  @ValidateNested({ each: true })
  @Type(() => PlaybookStepDto)
  steps?: PlaybookStepDto[];
}
