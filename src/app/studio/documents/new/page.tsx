import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft, FilePen, FileText, LayoutTemplate } from 'lucide-react';
import { Card, CardTitle, Notice, cx } from '@/components/ui';
import { PageHeader } from '@/components/layout/console-shell';
import { DocumentTemplateForm } from '@/components/studio/document-template-form';
import { createDocumentTemplateAction } from '@/app/actions/studio-documents';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import {
  DOCUMENT_PRESETS, MAX_DOCUMENT_TEMPLATES, documentTemplateTypeLabel, presetOf,
} from '@/server/services/documents';
import type { DocumentTemplateType } from '@/generated/prisma/enums';

export const dynamic = 'force-dynamic';

/**
 * 문서 서식 등록.
 *
 * 만드는 방법은 주소(?type=)로 정한다. 등록 후에는 바꿀 수 없다 —
 * 이미 발송된 작성 링크가 다른 화면을 그리면 후원자는 결제한 것과 다른 문서를 보게 된다.
 * 방법을 고르지 않고 들어오면 세 방법을 먼저 보여 준다.
 */

const METHODS = [
  { key: 'editor', type: 'EDITOR' as const, icon: FilePen },
  { key: 'file', type: 'FILE' as const, icon: FileText },
  { key: 'preset', type: 'PRESET' as const, icon: LayoutTemplate },
];

export default async function NewDocumentTemplatePage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; preset?: string }>;
}) {
  const { merchantId } = await requireMerchant();
  const sp = await searchParams;

  const [count, merchant] = await Promise.all([
    prisma.documentTemplate.count({ where: { merchantId, archivedAt: null } }),
    prisma.merchantProfile.findUnique({ where: { id: merchantId }, select: { id: true } }),
  ]);
  if (!merchant) notFound();
  const full = count >= MAX_DOCUMENT_TEMPLATES;

  const method = METHODS.find((m) => m.key === (sp.type ?? '').trim().toLowerCase()) ?? null;
  const preset = presetOf(sp.preset ?? null);

  return (
    <>
      <Link
        href="/studio/documents"
        className="mb-2 inline-flex items-center gap-1 text-[12.5px] font-bold text-ink-500 hover:text-ink-900"
      >
        <ChevronLeft size={15} strokeWidth={1.8} />
        문서 관리로
      </Link>

      <PageHeader
        title="문서 서식 등록"
        description={`후원자가 결제 뒤 작성할 서식을 만듭니다. 만드는 방법은 등록 후 바꿀 수 없습니다. (${count}/${MAX_DOCUMENT_TEMPLATES}개 사용)`}
      />

      {full ? (
        <Notice tone="warning" title={`서식이 이미 ${MAX_DOCUMENT_TEMPLATES}개입니다`}>
          관리할 수 있는 수를 넘기면 어떤 서식이 쓰이는지 알 수 없습니다. 먼저 쓰지 않는 서식을 보관해 주세요.
        </Notice>
      ) : !method ? (
        <MethodPicker />
      ) : method.type === 'PRESET' && !preset ? (
        <PresetPicker />
      ) : (
        <>
          <div className="mb-4">
            <Notice tone="neutral" title={documentTemplateTypeLabel[method.type as DocumentTemplateType].text}>
              {documentTemplateTypeLabel[method.type as DocumentTemplateType].hint}{' '}
              <Link href="/studio/documents/new" className="font-bold text-brand-700">
                다른 방법으로 만들기
              </Link>
            </Notice>
          </div>
          <DocumentTemplateForm
            action={createDocumentTemplateAction}
            templateType={method.type}
            template={null}
            fields={preset?.fields ?? []}
            defaultName={preset?.name}
            defaultDescription={preset?.description}
            defaultBody={preset?.body}
            presetKey={preset?.key ?? null}
            submitLabel="서식 등록"
          />
        </>
      )}
    </>
  );
}

function MethodPicker() {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {METHODS.map((m) => {
        const meta = documentTemplateTypeLabel[m.type as DocumentTemplateType];
        const Icon = m.icon;
        return (
          <Link
            key={m.key}
            href={`/studio/documents/new?type=${m.key}`}
            className={cx(
              'card flex flex-col gap-2 p-5 transition-all',
              'hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-[var(--shadow-lift)]',
            )}
          >
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand-50 text-brand-700">
              <Icon size={19} strokeWidth={1.7} />
            </span>
            <CardTitle>{meta.text}</CardTitle>
            <p className="text-[12.5px] leading-relaxed text-ink-500">{meta.hint}</p>
          </Link>
        );
      })}
    </div>
  );
}

function PresetPicker() {
  return (
    <>
      <div className="mb-3">
        <Notice tone="warning" title="기본 서식은 뼈대입니다">
          법률 검토를 받은 표준 약관이 아니라 작성 편의를 위한 예시입니다. 고른 뒤 사회복지기관 사정과 관계 법령에 맞게
          반드시 손봐서 쓰세요.
        </Notice>
      </div>
      <ul className="space-y-2.5">
        {DOCUMENT_PRESETS.filter(p => ['SUPPORT_AGREEMENT', 'CONSENT_PRIVACY', 'VOLUNTEER_APPLICATION', 'GOODS_DONATION', 'PROGRAM_APPLICATION'].includes(p.key)).map((p) => (
          <li key={p.key}>
            <Link href={`/studio/documents/new?type=preset&preset=${p.key}`} className="block">
              <Card className="transition-all hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-[var(--shadow-lift)]">
                <div className="flex items-center gap-3">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700">
                    <LayoutTemplate size={19} strokeWidth={1.7} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-bold text-ink-900">{p.name}</p>
                    <p className="mt-0.5 text-[12.5px] text-ink-500">{p.description}</p>
                    <p className="mt-0.5 text-[11.5px] text-ink-400">
                      입력 항목 {p.fields.length}개 · {p.requireSignature ? '서명 받음' : '서명 없음'}
                    </p>
                  </div>
                  <span className="shrink-0 text-[12px] font-bold text-brand-700">고르기</span>
                </div>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
