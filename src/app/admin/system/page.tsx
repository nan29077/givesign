import { Database, Server, TriangleAlert } from 'lucide-react';
import { PageHeader } from '@/components/layout/console-shell';
import { Card, CardTitle, SectionTitle, StatTile, Table, Th, Td, Badge, EmptyState, Notice, DataRow } from '@/components/ui';
import { SafetyBanner } from '@/components/admin/safety-banner';
import { shortId } from '@/components/admin/mask';
import { prisma } from '@/server/db';
import { requireAdmin } from '@/server/auth';
import { kv } from '@/server/redis';
import { env } from '@/lib/env';
import { formatNumber } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import { moResultLabel } from '@/lib/labels';

export const dynamic = 'force-dynamic';

async function checkDatabase(): Promise<{ ok: boolean; detail: string; latencyMs: number }> {
  const t0 = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, detail: '정상', latencyMs: Date.now() - t0 };
  } catch (e) {
    return { ok: false, detail: (e as Error).message, latencyMs: Date.now() - t0 };
  }
}

async function checkCache(): Promise<{ ok: boolean; detail: string; latencyMs: number }> {
  const t0 = Date.now();
  try {
    await kv.set('health:admin:ping', '1', 10);
    const v = await kv.get('health:admin:ping');
    return v === '1'
      ? { ok: true, detail: '정상', latencyMs: Date.now() - t0 }
      : { ok: false, detail: '읽기/쓰기 결과 불일치', latencyMs: Date.now() - t0 };
  } catch (e) {
    return { ok: false, detail: (e as Error).message, latencyMs: Date.now() - t0 };
  }
}

export default async function AdminSystemPage() {
  // 레이아웃 가드에만 기대지 않는다. App Router 는 layout 과 page 를 함께 렌더하므로
  // 비관리자 요청에서도 이 페이지의 조회가 실행될 수 있다(스튜디오·마이페이지와 같은 규약).
  await requireAdmin();

  const [db, cache, webhooks, moErrors, paymentErrors] = await Promise.all([
    checkDatabase(),
    checkCache(),
    prisma.webhookLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: {
        id: true, source: true, endpoint: true, method: true, signatureOk: true,
        statusCode: true, latencyMs: true, ip: true, responseNote: true, createdAt: true,
      },
    }),
    prisma.moInboundMessage.findMany({
      where: { result: { in: ['ERROR', 'UNKNOWN_ROUTE'] } },
      orderBy: { receivedAt: 'desc' },
      take: 10,
      select: { id: true, receivedNumber: true, result: true, resultDetail: true, receivedAt: true },
    }),
    prisma.paymentAttempt.findMany({
      where: { errorCode: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true, operation: true, errorCode: true, errorMessage: true, latencyMs: true, createdAt: true,
        transaction: { select: { orderNo: true, status: true } },
      },
    }),
  ]);

  const providers: Array<{ label: string; mode: string }> = [
    { label: '결제(PG)', mode: env.payment.provider },
    { label: 'MO 수신', mode: env.mo.provider },
    { label: 'MT 발송', mode: env.mt.provider },
    { label: '암호화', mode: env.crypto.provider },
  ];

  const signatureFailures = webhooks.filter((w) => !w.signatureOk).length;

  return (
    <>
      <PageHeader
        title="시스템 상태"
        description="/api/health 와 동일한 점검을 관리자 화면에서 직접 수행합니다. 새로고침할 때마다 재점검합니다."
      />

      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-3">
          <StatTile
            label="데이터베이스"
            value={db.ok ? '정상' : '오류'}
            sub={`${db.latencyMs}ms · ${db.ok ? 'PostgreSQL 연결' : db.detail.slice(0, 60)}`}
            tone={db.ok ? 'success' : 'danger'}
          />
          <StatTile
            label="캐시(Redis)"
            value={cache.ok ? '정상' : '오류'}
            sub={`${cache.latencyMs}ms · ${env.redisUrl ? 'Redis' : `인메모리 폴백 ${env.allowInMemoryFallback ? '허용' : '금지'}`}`}
            tone={cache.ok ? 'success' : 'danger'}
          />
          <StatTile
            label="Webhook 서명 실패"
            value={`${formatNumber(signatureFailures)} / ${formatNumber(webhooks.length)}`}
            sub="최근 30건 기준"
            tone={signatureFailures > 0 ? 'danger' : 'success'}
          />
        </div>

        <SafetyBanner />

        <section>
          <SectionTitle title="외부 연동 모드" description="mock 은 실제 외부 호출 없이 모의 응답을 반환합니다." />
          <Card>
            {providers.map((p) => (
              <DataRow
                key={p.label}
                label={p.label}
                value={
                  <Badge tone={p.mode === 'mock' || p.mode === 'local' ? 'warning' : 'success'}>{p.mode}</Badge>
                }
              />
            ))}
            <DataRow label="APP_BASE_URL" value={env.baseUrl} />
            <DataRow label="MO 허용 IP" value={env.mo.allowedIps.length > 0 ? env.mo.allowedIps.join(', ') : '미설정'} />
          </Card>
        </section>

        <section>
          <SectionTitle
            title="최근 Webhook 로그 30건"
            description="서명 검증 결과와 응답 지연을 함께 확인합니다. 본문은 마스킹 스냅샷만 저장됩니다."
          />
          {webhooks.length === 0 ? (
            <EmptyState title="수신된 Webhook 이 없습니다" description="MO 사업자 연동 전에는 시뮬레이터로 흐름을 검증하세요." />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>수신 시각</Th>
                  <Th>출처</Th>
                  <Th>엔드포인트</Th>
                  <Th>서명</Th>
                  <Th className="text-right">상태코드</Th>
                  <Th className="text-right">지연</Th>
                  <Th>IP</Th>
                  <Th>비고</Th>
                </tr>
              </thead>
              <tbody>
                {webhooks.map((w) => (
                  <tr key={w.id}>
                    <Td className="whitespace-nowrap">{formatKst(w.createdAt)}</Td>
                    <Td>{w.source}</Td>
                    <Td className="font-mono text-[12px]">{`${w.method} ${w.endpoint}`}</Td>
                    <Td>
                      <Badge tone={w.signatureOk ? 'success' : 'danger'}>{w.signatureOk ? '검증 성공' : '검증 실패'}</Badge>
                    </Td>
                    <Td className="text-right tabular-nums">{w.statusCode ?? '-'}</Td>
                    <Td className="text-right tabular-nums">{w.latencyMs != null ? `${w.latencyMs}ms` : '-'}</Td>
                    <Td>{w.ip ?? '-'}</Td>
                    <Td className="max-w-[220px] break-words">{w.responseNote ?? '-'}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          <section>
            <SectionTitle title="최근 MO 처리 오류" description="라우팅 실패 및 처리 오류 최근 10건" />
            {moErrors.length === 0 ? (
              <EmptyState title="최근 MO 처리 오류가 없습니다" />
            ) : (
              <Table className="min-w-0">
                <thead>
                  <tr>
                    <Th>시각</Th>
                    <Th>수신번호</Th>
                    <Th>결과</Th>
                    <Th>상세</Th>
                  </tr>
                </thead>
                <tbody>
                  {moErrors.map((m) => (
                    <tr key={m.id}>
                      <Td className="whitespace-nowrap">{formatKst(m.receivedAt, false)}</Td>
                      <Td>{m.receivedNumber}</Td>
                      <Td>
                        <Badge tone={moResultLabel[m.result].tone}>{moResultLabel[m.result].text}</Badge>
                      </Td>
                      <Td className="max-w-[200px] break-words">{m.resultDetail ?? '-'}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </section>

          <section>
            <SectionTitle title="최근 결제 오류" description="PG 호출 실패 최근 10건" />
            {paymentErrors.length === 0 ? (
              <EmptyState title="최근 결제 오류가 없습니다" />
            ) : (
              <Table className="min-w-0">
                <thead>
                  <tr>
                    <Th>시각</Th>
                    <Th>주문번호</Th>
                    <Th>동작</Th>
                    <Th>오류</Th>
                    <Th className="text-right">지연</Th>
                  </tr>
                </thead>
                <tbody>
                  {paymentErrors.map((a) => (
                    <tr key={a.id}>
                      <Td className="whitespace-nowrap">{formatKst(a.createdAt, false)}</Td>
                      <Td className="font-mono text-[12px]">{shortId(a.transaction.orderNo, 8, 4)}</Td>
                      <Td>{a.operation}</Td>
                      <Td className="max-w-[200px] break-words">
                        <span className="font-semibold text-danger-500">{a.errorCode}</span>
                        {a.errorMessage ? <span className="block text-ink-500">{a.errorMessage}</span> : null}
                      </Td>
                      <Td className="text-right tabular-nums">{a.latencyMs != null ? `${a.latencyMs}ms` : '-'}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </section>
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          <Card>
            <div className="mb-2 flex items-center gap-2">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-ink-50 text-brand-700">
                <Database size={16} strokeWidth={1.7} />
              </span>
              <CardTitle>데이터베이스</CardTitle>
            </div>
            <p className="text-[13px] leading-relaxed text-ink-500">
              운영에서는 RDS Proxy 또는 PgBouncer 를 경유하고, 마이그레이션은 DIRECT_DATABASE_URL 로 수행합니다.
            </p>
          </Card>
          <Card>
            <div className="mb-2 flex items-center gap-2">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-ink-50 text-brand-700">
                <Server size={16} strokeWidth={1.7} />
              </span>
              <CardTitle>캐시</CardTitle>
            </div>
            <p className="text-[13px] leading-relaxed text-ink-500">
              한도·속도 제한 카운터는 캐시에 저장되고 ChargeCounter 가 영속 원본입니다. 운영에서는 인메모리 폴백을
              금지해야 합니다.
            </p>
          </Card>
        </div>

        {!db.ok || !cache.ok ? (
          <Notice tone="danger" title="점검 실패 항목이 있습니다">
            <span className="flex items-start gap-1.5">
              <TriangleAlert size={14} strokeWidth={1.7} className="mt-0.5 shrink-0" />
              <span>
                {!db.ok ? `DB: ${db.detail}` : ''}
                {!db.ok && !cache.ok ? ' / ' : ''}
                {!cache.ok ? `캐시: ${cache.detail}` : ''}
              </span>
            </span>
          </Notice>
        ) : null}
      </div>
    </>
  );
}
