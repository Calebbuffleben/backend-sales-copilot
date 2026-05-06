import { Test } from '@nestjs/testing';
import { PlaybookResolverService } from './playbook-resolver.service';
import { PrismaService } from '../prisma/prisma.service';

describe('PlaybookResolverService', () => {
  const findUnique = jest.fn();

  beforeEach(() => {
    jest.resetAllMocks();
    process.env.PLAYBOOK_URL_ALLOWLIST =
      'allowed.example.com,docs.safe.org';
  });

  afterEach(() => {
    delete process.env.PLAYBOOK_URL_ALLOWLIST;
  });

  async function createService() {
    const module = await Test.createTestingModule({
      providers: [
        PlaybookResolverService,
        {
          provide: PrismaService,
          useValue: {
            playbookTemplate: { findUnique },
          },
        },
      ],
    }).compile();
    return module.get(PlaybookResolverService);
  }

  it('returns undefined when hint is empty', async () => {
    const service = await createService();
    await expect(
      service.resolve({ tenantId: 't1', playbookHintJson: '' }),
    ).resolves.toBeUndefined();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('returns undefined when template row is missing', async () => {
    findUnique.mockResolvedValue(null);
    const service = await createService();
    const hint = JSON.stringify({
      playbook_template_key: 'missing',
      playbook_variables: {},
    });
    await expect(
      service.resolve({ tenantId: 'tenant-a', playbookHintJson: hint }),
    ).resolves.toBeUndefined();
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        tenantId_key: { tenantId: 'tenant-a', key: 'missing' },
      },
    });
  });

  it('interpolates variables and returns metadata with copy_text step', async () => {
    findUnique.mockResolvedValue({
      id: 'id1',
      tenantId: 'tenant-a',
      key: 'obj_price',
      title: 'Objeção — {{topic}}',
      description: null,
      steps: [
        {
          id: 'copy',
          label: 'Copiar: {{script}}',
          action: { type: 'copy_text', payload: '{{script}}' },
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const service = await createService();
    const hint = JSON.stringify({
      playbook_template_key: 'obj_price',
      playbook_variables: {
        topic: 'preço',
        script: 'Posso detalhar o ROI?',
      },
    });

    const out = await service.resolve({
      tenantId: 'tenant-a',
      playbookHintJson: hint,
    });

    expect(out).toMatchObject({
      templateKey: 'obj_price',
      title: 'Objeção — preço',
      steps: [
        {
          id: 'copy',
          label: 'Copiar: Posso detalhar o ROI?',
          action: {
            type: 'copy_text',
            payload: 'Posso detalhar o ROI?',
          },
        },
      ],
    });
  });

  it('drops open_url step when URL host is not allowlisted', async () => {
    findUnique.mockResolvedValue({
      id: 'id2',
      tenantId: 't',
      key: 'bad_link',
      title: 'T',
      description: null,
      steps: [
        {
          id: 'evil',
          label: 'Abrir',
          action: {
            type: 'open_url',
            payload: 'https://evil.example/phish',
          },
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const service = await createService();
    const out = await service.resolve({
      tenantId: 't',
      playbookHintJson: JSON.stringify({
        playbook_template_key: 'bad_link',
      }),
    });

    expect(out).toBeUndefined();
  });

  it('keeps open_url when host is allowlisted', async () => {
    findUnique.mockResolvedValue({
      id: 'id3',
      tenantId: 't',
      key: 'good_link',
      title: 'Docs',
      description: null,
      steps: [
        {
          id: 'doc',
          label: 'Guia',
          action: {
            type: 'open_url',
            payload: 'https://docs.safe.org/guide',
          },
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const service = await createService();
    const out = await service.resolve({
      tenantId: 't',
      playbookHintJson: JSON.stringify({
        playbook_template_key: 'good_link',
      }),
    });

    expect(out?.steps).toHaveLength(1);
    expect(out?.steps[0].action).toEqual({
      type: 'open_url',
      payload: 'https://docs.safe.org/guide',
    });
  });
});
