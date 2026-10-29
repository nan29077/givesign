import Link from 'next/link';
import { ChevronRight, FileText, KeyRound } from 'lucide-react';
import { Badge, Card, CardTitle, DataRow, LinkButton, Notice } from '@/components/ui';
import { PageHeader } from '@/components/layout/console-shell';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { env } from '@/lib/env';
import { API_BASE_PATH, API_STATUS_LABEL, endpointCounts, orderedCategories } from '@/server/api-docs';

export const dynamic = 'force-dynamic';

/**
 * 사회복지기관 API 문서 허브.
 *
 * 카테고리 목록은 손으로 적지 않고 레지스트리(`src/server/api-docs`)에서 만든다.
 * 새 API 를 레지스트리에 등록하면 이 화면에 자동으로 올라온다.
 */
export default async function StudioDocsPage() {
  const session = await requireMerchant();

  const activeKeys = await prisma.merchantApiKey.count({
    where: { merchantId: session.merchantId, revokedAt: null },
  });

  const categories = orderedCategories();
  const counts = endpointCounts();

  return (
    <>
      <PageHeader
        title="API 문서"
        description="사회복지기관 사이트에 기브싸인을 연동하는 방법입니다. 연동은 선택이며, 붙이지 않아도 콘솔에서 모든 처리를 할 수 있습니다."
      />

      <div className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr]">
          <Card>
            <CardTitle>연동 정보</CardTitle>
            <div className="mt-2">
              <DataRow
                label="기본 URL"
                value={<code className="font-mono text-[12px]">{`${env.baseUrl}${API_BASE_PATH}`}</code>}
              />
              <DataRow label="현재 버전" value="v1" />
              <DataRow
                label="내 API 키"
                value={
                  activeKeys > 0 ? (
                    <Badge tone="success">{`발급됨 ${activeKeys}개`}</Badge>
                  ) : (
                    <Badge tone="warning">미발급</Badge>
                  )
                }
              />
              <DataRow
                label="엔드후원금"
                value={`제공 중 ${counts.live}개 · 준비 중 ${counts.planned}개`}
              />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <LinkButton href="/studio/settings?tab=api" variant="secondary" size="sm" prefetch={false}>
                <KeyRound size={14} strokeWidth={1.9} />
                API 키 관리
              </LinkButton>
              <LinkButton href="/studio/docs/partner-api" variant="ghost" size="sm" prefetch={false}>
                <FileText size={14} strokeWidth={1.9} />
                규격서 원문 보기
              </LinkButton>
            </div>
          </Card>

          <Card>
            <CardTitle>상태 표시를 먼저 확인해 주세요</CardTitle>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-500">
              앞으로 열릴 API 도 미리 공개하고 있습니다. 계획을 함께 세우실 수 있도록 한 것이며,{' '}
              <strong>준비 중 항목은 아직 호출되지 않습니다.</strong>
            </p>
            <div className="mt-3 space-y-2">
              <p className="text-[12.5px] text-ink-700">
                <Badge tone="success">제공 중</Badge>{' '}
                <span className="ml-1">지금 호출하면 동작합니다. 규격이 확정되어 있습니다.</span>
              </p>
              <p className="text-[12.5px] text-ink-700">
                <Badge tone="warning">베타</Badge>{' '}
                <span className="ml-1">동작하지만 규격이 바뀔 수 있습니다. 사전 신청 후 사용합니다.</span>
              </p>
              <p className="text-[12.5px] text-ink-700">
                <Badge tone="neutral">준비 중</Badge>{' '}
                <span className="ml-1">아직 동작하지 않습니다. 규격은 예고이며 바뀔 수 있습니다.</span>
              </p>
            </div>
          </Card>
        </div>

        {activeKeys === 0 ? (
          <Notice tone="warning" title="아직 API 키가 없습니다">
            연동을 시작하려면 후원 설정 → 연동 탭에서 키를 먼저 발급해 주세요. 키 원문과 서명 비밀키는{' '}
            <strong>발급 직후 한 번만</strong> 표시됩니다.
          </Notice>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          {categories.map((category) => {
            const status = API_STATUS_LABEL[category.status];
            const endpoints = category.endpoints ?? [];
            const live = endpoints.filter((e) => e.status === 'LIVE').length;
            const planned = endpoints.filter((e) => e.status === 'PLANNED').length;

            return (
              <Link
                key={category.slug}
                href={`/studio/docs/${category.slug}`}
                prefetch={false}
                className="group rounded-[18px] border border-ink-200 bg-white p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-md"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[11px] font-bold text-ink-300">
                      {String(category.order).padStart(2, '0')}
                    </p>
                    <p className="mt-0.5 text-[14.5px] font-extrabold text-ink-900">{category.title}</p>
                  </div>
                  <Badge tone={status.tone}>{status.text}</Badge>
                </div>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-500">{category.summary}</p>
                <div className="mt-3 flex items-center justify-between">
                  <span className="text-[11.5px] font-semibold text-ink-400">
                    {endpoints.length === 0
                      ? '설명 문서'
                      : `엔드후원금 ${endpoints.length}개${live > 0 ? ` · 제공 중 ${live}` : ''}${planned > 0 ? ` · 준비 중 ${planned}` : ''}`}
                  </span>
                  <ChevronRight
                    size={16}
                    strokeWidth={1.6}
                    className="text-ink-300 transition-transform group-hover:translate-x-0.5 group-hover:text-brand-600"
                  />
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </>
  );
}
