import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { Badge, Card, CardTitle, Notice, Table, Td, Th } from '@/components/ui';
import { PageHeader } from '@/components/layout/console-shell';
import { CopyButton } from '@/components/public/copy-button';
import { requireMerchant } from '@/server/auth';
import { env } from '@/lib/env';
import {
  API_BASE_PATH,
  API_STATUS_LABEL,
  PLANNED_NOTICE,
  findCategory,
  orderedCategories,
  type ApiEndpoint,
} from '@/server/api-docs';

export const dynamic = 'force-dynamic';

// 정적 경로(`/studio/docs/partner-api`)가 동적 세그먼트보다 우선하므로,
// 여기서는 레지스트리에 등록된 slug 만 처리하고 나머지는 404 로 보낸다.
// 로그인 상태에 따라 내용이 달라지므로 정적 생성(generateStaticParams)은 쓰지 않는다.

const METHOD_TONE: Record<ApiEndpoint['method'], 'success' | 'brand' | 'warning' | 'danger'> = {
  GET: 'success',
  POST: 'brand',
  PATCH: 'warning',
  DELETE: 'danger',
};

export default async function StudioDocsCategoryPage({ params }: { params: Promise<{ slug: string }> }) {
  await requireMerchant();
  const { slug } = await params;

  const category = findCategory(slug);
  if (!category) notFound();

  const status = API_STATUS_LABEL[category.status];
  const endpoints = category.endpoints ?? [];
  // 카테고리 전체가 준비 중인 경우와, 제공 중이지만 일부 항목만 준비 중인 경우를 구분한다.
  // 둘을 같은 문구로 묶으면 이미 쓸 수 있는 문서에도 "아직 제공되지 않습니다" 가 붙어
  // 사회복지기관이 멀쩡한 API 를 못 쓰는 것으로 오해한다.
  const allPlanned = category.status === 'PLANNED';
  const somePlanned = !allPlanned && endpoints.some((e) => e.status === 'PLANNED');

  return (
    <>
      <Link
        href="/studio/docs"
        className="mb-2 inline-flex items-center gap-1 text-[12.5px] font-bold text-ink-500 hover:text-ink-900"
      >
        <ChevronLeft size={15} strokeWidth={1.8} />
        API 문서로
      </Link>

      <PageHeader title={category.title} description={category.summary} />

      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={status.tone}>{status.text}</Badge>
          <span className="text-[12px] font-semibold text-ink-400">
            {`${String(category.order).padStart(2, '0')} · ${API_BASE_PATH}`}
          </span>
        </div>

        {allPlanned ? (
          <Notice tone="warning" title="아직 제공되지 않는 항목입니다">
            {PLANNED_NOTICE}
          </Notice>
        ) : somePlanned ? (
          <Notice tone="neutral" title="일부 항목이 준비 중입니다">
            아래 목록에서 <strong>준비 중</strong> 배지가 붙은 항목은 아직 호출되지 않습니다. 그 항목의 규격은 예고이며
            바뀔 수 있습니다. <strong>제공 중</strong> 항목은 지금 그대로 쓰실 수 있습니다.
          </Notice>
        ) : null}

        <Card>
          {category.intro.map((paragraph, i) => (
            <p key={i} className="mb-2 text-[13px] leading-relaxed text-ink-700 last:mb-0">
              {paragraph}
            </p>
          ))}
        </Card>

        {(category.sections ?? []).map((section) => (
          <Card key={section.heading}>
            <CardTitle>{section.heading}</CardTitle>
            <div className="mt-2 space-y-2">
              {section.body.map((paragraph, i) => (
                <p key={i} className="text-[13px] leading-relaxed text-ink-700">
                  {paragraph}
                </p>
              ))}
            </div>
            {section.code ? (
              <div className="mt-3">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-[11.5px] font-bold text-ink-400">{section.code.label}</span>
                  <CopyButton value={section.code.text} />
                </div>
                {/* 코드 블록은 렌더링하지 않고 원문 그대로 둔다. 서명 예시가 조용히 바뀌면 연동이 깨진다. */}
                <pre className="overflow-x-auto rounded-xl border border-ink-200 bg-ink-50 px-3 py-2.5 font-mono text-[12px] leading-relaxed text-ink-800">
                  {section.code.text}
                </pre>
              </div>
            ) : null}
          </Card>
        ))}

        {endpoints.length > 0 ? (
          <section>
            <h2 className="mb-2 mt-1 text-[15px] font-extrabold text-ink-900">엔드포인트</h2>

            <Table className="min-w-[860px]">
              <thead>
                <tr>
                  <Th>상태</Th>
                  <Th>메서드</Th>
                  <Th>경로</Th>
                  <Th>설명</Th>
                  <Th>서명</Th>
                </tr>
              </thead>
              <tbody>
                {endpoints.map((endpoint) => {
                  const s = API_STATUS_LABEL[endpoint.status];
                  return (
                    <tr key={`${endpoint.method} ${endpoint.path}`}>
                      <Td>
                        <Badge tone={s.tone}>{s.text}</Badge>
                      </Td>
                      <Td>
                        <Badge tone={METHOD_TONE[endpoint.method]}>{endpoint.method}</Badge>
                      </Td>
                      <Td>
                        <code className="font-mono text-[12px] text-ink-900">{`${API_BASE_PATH}${endpoint.path}`}</code>
                      </Td>
                      <Td>
                        <span className="font-semibold text-ink-900">{endpoint.summary}</span>
                        {endpoint.sandboxOnly ? (
                          <span className="ml-1.5 align-middle">
                            <Badge tone="brand">테스트 키 전용</Badge>
                          </span>
                        ) : null}
                      </Td>
                      <Td>{endpoint.signed ? '필요' : '불필요'}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>

            <div className="mt-4 space-y-3">
              {endpoints
                .filter((e) => e.description || e.params?.length || e.notes?.length || e.responseExample)
                .map((endpoint) => (
                  <Card key={`detail-${endpoint.method} ${endpoint.path}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={METHOD_TONE[endpoint.method]}>{endpoint.method}</Badge>
                      <code className="font-mono text-[12.5px] font-bold text-ink-900">
                        {`${API_BASE_PATH}${endpoint.path}`}
                      </code>
                      <Badge tone={API_STATUS_LABEL[endpoint.status].tone}>
                        {API_STATUS_LABEL[endpoint.status].text}
                      </Badge>
                    </div>

                    {endpoint.description ? (
                      <p className="mt-2 text-[13px] leading-relaxed text-ink-700">{endpoint.description}</p>
                    ) : null}

                    {endpoint.params && endpoint.params.length > 0 ? (
                      <div className="mt-3">
                        <p className="mb-1.5 text-[11.5px] font-bold text-ink-400">파라미터</p>
                        <div className="rounded-xl border border-ink-100">
                          {endpoint.params.map((param) => (
                            <div
                              key={`${param.in}-${param.name}`}
                              className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-ink-100 px-3 py-2 last:border-0"
                            >
                              <code className="font-mono text-[12px] font-bold text-ink-900">{param.name}</code>
                              <span className="text-[11px] font-semibold text-ink-400">
                                {param.in} · {param.type}
                                {param.required ? ' · 필수' : ''}
                              </span>
                              <span className="w-full text-[12.5px] text-ink-700 sm:w-auto sm:flex-1">
                                {param.description}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {endpoint.notes && endpoint.notes.length > 0 ? (
                      <ul className="mt-3 space-y-1">
                        {endpoint.notes.map((note, i) => (
                          <li key={i} className="text-[12.5px] leading-relaxed text-ink-500">
                            · {note}
                          </li>
                        ))}
                      </ul>
                    ) : null}

                    {endpoint.responseExample ? (
                      <div className="mt-3">
                        <div className="mb-1.5 flex items-center justify-between">
                          <span className="text-[11.5px] font-bold text-ink-400">응답 예시</span>
                          <CopyButton value={endpoint.responseExample} />
                        </div>
                        <pre className="overflow-x-auto rounded-xl border border-ink-200 bg-ink-50 px-3 py-2.5 font-mono text-[12px] leading-relaxed text-ink-800">
                          {endpoint.responseExample}
                        </pre>
                      </div>
                    ) : null}
                  </Card>
                ))}
            </div>
          </section>
        ) : null}

        <Card>
          <CardTitle>다른 문서</CardTitle>
          <div className="mt-2 flex flex-wrap gap-2">
            {orderedCategories()
              .filter((c) => c.slug !== category.slug)
              .map((c) => (
                <Link
                  key={c.slug}
                  href={`/studio/docs/${c.slug}`}
                  prefetch={false}
                  className="rounded-lg border border-ink-200 bg-white px-2.5 py-1.5 text-[12px] font-semibold text-ink-700 transition-colors hover:bg-ink-50"
                >
                  {c.title}
                </Link>
              ))}
          </div>
        </Card>

        <p className="pb-2 text-[11.5px] text-ink-300">
          기본 URL {env.baseUrl}
          {API_BASE_PATH}
        </p>
      </div>
    </>
  );
}
