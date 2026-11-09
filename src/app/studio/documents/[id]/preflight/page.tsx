import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, Notice } from '@/components/ui';
import { PdfBytesPreview } from '@/components/studio/pdf-bytes-preview';
import { PREFLIGHT_LEVEL_LABEL, SAMPLE_KIND_LABEL } from '@/lib/document-preflight';
import { previewPurposeTemplate, previewTemplateWithStress, type SamplePreview } from '@/server/services/document-preflight';
import { DOCUMENT_PURPOSE_LABEL } from '@/server/services/purpose-documents';
import { isDocumentPurpose } from '@/server/services/purpose-templates';

export const dynamic = 'force-dynamic';

/**
 * 문서 발송 전 점검 (2026-11-09 C2).
 *  - ?mode=stress : 가상의 긴 표본 값(긴 이름·큰 금액)으로 칸 넘침·빈칸을 미리 본다(서식 등록·수정 화면 "점검").
 *  - 기본        : 용도별 서식이면 이 기관 최근 후원자로 표본 3건(정상·빈칸·이름이 가장 긴 것)을 실제 렌더 결과로 본다.
 * 저장·발송하지 않는다. 후원자 이름 외 개인정보(전화·주민번호)는 머지 단계에서 가린다.
 */
export default async function DocumentPreflightPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ mode?: string }> }) {
  const { merchantId } = await requireMerchant();
  const { id } = await params;
  const sp = await searchParams;
  const t = await prisma.documentTemplate.findFirst({ where: { id, merchantId }, select: { id: true, name: true, purpose: true, templateType: true } });
  if (!t) notFound();
  const stress = sp.mode === 'stress' || !t.purpose;
  let samples: SamplePreview[] = [];
  let total = 0;
  if (stress) {
    const p = await previewTemplateWithStress(merchantId, id);
    samples = p ? [p] : [];
  } else {
    const r = await previewPurposeTemplate(merchantId, id);
    samples = r?.samples ?? [];
    total = r?.total ?? 0;
  }
  const purposeLabel = isDocumentPurpose(t.purpose) ? DOCUMENT_PURPOSE_LABEL[t.purpose] : null;

  return (
    <>
      <Link href={`/studio/documents/${t.id}`} className="mb-2 inline-flex items-center gap-1 text-[12.5px] font-bold text-ink-500 hover:text-ink-900">
        <ChevronLeft size={15} strokeWidth={1.8} />
        서식으로
      </Link>
      <PageHeader
        title={`발송 전 점검 — ${t.name}`}
        description={stress ? '가상의 긴 표본 값으로 채워 봅니다. 저장·발송하지 않습니다.' : `${purposeLabel ?? ''} 자동 발송 대상 ${total}명 중 표본입니다. 저장·발송하지 않습니다.`}
      />
      <div className="mb-4 flex flex-wrap gap-2 text-[12.5px]">
        {t.purpose ? (
          <Link href={`/studio/documents/${t.id}/preflight`} className={`rounded-full px-3 py-1 font-bold ${!stress ? 'bg-brand-400 text-ink-900' : 'bg-ink-50 text-ink-500'}`}>실제 후원자 표본</Link>
        ) : null}
        <Link href={`/studio/documents/${t.id}/preflight?mode=stress`} className={`rounded-full px-3 py-1 font-bold ${stress ? 'bg-brand-400 text-ink-900' : 'bg-ink-50 text-ink-500'}`}>가상의 긴 표본</Link>
      </div>
      {samples.length === 0 ? (
        <Notice tone="neutral">점검할 표본이 없습니다.</Notice>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          {samples.map((s) => (
            <Card key={`${s.kind}:${s.key}`}>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle>{stress ? '가상의 긴 표본' : SAMPLE_KIND_LABEL[s.kind]}</CardTitle>
                <Badge tone={PREFLIGHT_LEVEL_LABEL[s.preflight.level].tone}>{PREFLIGHT_LEVEL_LABEL[s.preflight.level].text}</Badge>
              </div>
              {!stress ? <p className="mt-0.5 text-[11.5px] text-ink-400">{s.label}</p> : null}
              {s.preflight.issues.length ? (
                <ul className="mt-2 space-y-1 text-[12px]">
                  {s.preflight.issues.map((i, n) => (
                    <li key={n} className={i.severity === 'block' ? 'text-danger-500' : 'text-warning-500'}>
                      {i.severity === 'block' ? '보내지 않음' : '확인'}: {i.message}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-[12px] text-success-500">문제가 보이지 않습니다.</p>
              )}
              <div className="mt-3">
                {s.pdfDataUrl ? (
                  <PdfBytesPreview base64={s.pdfDataUrl.replace(/^data:application\/pdf;base64,/, '')} label={s.label} />
                ) : s.html ? (
                  <div
                    className="max-h-[420px] overflow-auto whitespace-normal break-keep rounded-xl border border-ink-100 bg-white p-3 text-[12.5px] leading-relaxed text-ink-800 [&_mark]:rounded [&_mark]:bg-brand-50 [&_mark]:px-0.5 [&_mark[data-merge=missing]]:bg-warning-50 [&_mark[data-merge=unknown]]:bg-danger-50"
                    // renderMergeHtml 은 본문과 값을 모두 이스케이프한 뒤 표시용 태그만 넣는다.
                    dangerouslySetInnerHTML={{ __html: s.html }}
                  />
                ) : (
                  <p className="text-[12px] text-ink-400">미리볼 본문이 없습니다.</p>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
      <div className="mt-4">
        <Notice tone="neutral" title="점검 기준">
          필수 항목(감사장은 후원자명·기관명, 약정서는 금액·출금일, 활동 확인서는 활동 시간 등)이 비었거나, 받는 사람에게 연락처가 없거나 탈퇴·차단이면 보내지 않습니다.
          긴 이름이 칸을 넘을 수 있거나 모르는 머지 필드가 있으면 보내되 발급 기록에 경고를 남깁니다. 서식에 쓰지 않은 필드는 보지 않습니다.
        </Notice>
      </div>
    </>
  );
}
