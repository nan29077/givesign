import Link from 'next/link';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, Checkbox, Field, Input, Notice, StatTile, Table, Td, Th } from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { formatKst } from '@/lib/datetime';
import { formatNumber } from '@/lib/money';
import { journeySettings, journeyStats, journeyDef, JOURNEY_WEEKLY_SEND_CAP } from '@/server/services/journeys';
import { cancelJourneyRunAction, saveJourneyAction } from '@/app/actions/journeys';
import { OutboundPanel } from '@/components/studio/outbound-panel';

export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<string, { label: string; tone: 'neutral' | 'brand' | 'success' | 'warning' | 'danger' }> = {
  WAITING: { label: '대기', tone: 'brand' },
  RUNNING: { label: '진행 중', tone: 'brand' },
  AWAITING_APPROVAL: { label: '승인 대기', tone: 'warning' },
  DONE: { label: '완료', tone: 'success' },
  STOPPED: { label: '멈춤', tone: 'neutral' },
  CANCELED: { label: '취소', tone: 'neutral' },
  FAILED: { label: '실패', tone: 'danger' },
};

const OUTCOME_LABEL: Record<string, string> = {
  DONE: '완료', SKIPPED: '건너뜀', WAIT: '대기', AWAITING_APPROVAL: '승인 대기', APPROVED: '승인', REJECTED: '반려',
  BLOCKED: '보류', FAILED: '오류', STOPPED: '멈춤', RETRY: '다시 실행',
};

/**
 * 자동 안내(저니).
 *
 * 후원·정기후원·봉사·영수증 사건이 생기면 감사장·확인서·안내 문자를 기관 서식으로 자동 발송한다.
 * 기관은 저니를 켜고 끄고, 단계마다 '승인 후 보내기' 를 고르고, 몇 가지 값(기준 금액·대기 일수 등)을 바꾼다.
 * 모든 발송은 정보성이고, 후원자 수신 거부·야간·후원자당 주간 상한을 지킨다.
 */
export default async function StudioJourneysPage() {
  const { merchantId } = await requireMerchant();
  const [settings, stats, runs] = await Promise.all([
    journeySettings(merchantId),
    journeyStats(merchantId),
    prisma.journeyRun.findMany({
      where: { merchantId },
      orderBy: { startedAt: 'desc' },
      take: 30,
      include: { logs: { orderBy: { at: 'desc' }, take: 1 } },
    }),
  ]);
  const payers = new Map(
    (await prisma.payerProfile.findMany({ where: { id: { in: runs.map((r) => r.payerId).filter((x): x is string => Boolean(x)) } }, select: { id: true, displayName: true, phoneMasked: true } })).map((p) => [p.id, p]),
  );
  const count = (key: string, status?: string) => stats.runs.filter((r) => r.journeyKey === key && (!status || r.status === status)).reduce((a, r) => a + r._count._all, 0);
  const totalSent = [...stats.sent.values()].reduce((a, n) => a + n, 0);
  const awaiting = stats.runs.filter((r) => r.status === 'AWAITING_APPROVAL').reduce((a, r) => a + r._count._all, 0);
  const groups = [...new Set(settings.map((s) => s.def.group))];

  return (
    <>
      <PageHeader
        title="자동 안내"
        description="후원·정기후원·봉사·영수증 사건이 생기면 기관 서식으로 감사장·확인서·안내를 자동으로 보냅니다. 필요한 단계는 승인 대기함에서 확인한 뒤 보내도록 바꿀 수 있습니다."
      />
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="켜진 자동 안내" value={`${settings.filter((s) => s.enabled).length} / ${settings.length}`} tone="brand" />
        <StatTile label="최근 30일 자동 발송" value={`${formatNumber(totalSent)}건`} />
        <StatTile label="승인 대기" value={`${formatNumber(awaiting)}건`} tone={awaiting ? 'warning' : 'neutral'} sub={awaiting ? '승인 대기함에서 처리' : undefined} />
        <StatTile label="후원자 보호" value={`7일 ${JOURNEY_WEEKLY_SEND_CAP}건`} sub="월간 안내 등 정보성 안내 합산 · 야간(21~9시) 보류 · 수신 거부 제외" />
      </div>
      <Notice tone="neutral">
        감사장·확인서는 <Link href="/studio/documents" className="font-semibold underline">서식·제출 문서</Link>에서 용도별로 지정한 서식(없으면 기브싸인 기본 서식)으로 만들어집니다.
        후원 권유 같은 광고성 안내는 보내지 않습니다. 후원자가 이 기관 안내 수신을 끄면 자동 안내도 멈춥니다.
      </Notice>

      {groups.map((g) => (
        <section key={g} className="mt-6">
          <h2 className="mb-3 text-[15px] font-black text-ink-900">{g}</h2>
          <div className="grid gap-4 xl:grid-cols-2">
            {settings.filter((s) => s.def.group === g).map((s) => (
              <Card key={s.def.key}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-[15px] font-black text-ink-900">{s.def.label}</h3>
                    <p className="mt-1 text-[12.5px] leading-relaxed text-ink-500">{s.def.description}</p>
                  </div>
                  <Badge tone={s.enabled ? 'success' : 'neutral'}>{s.enabled ? '켜짐' : '꺼짐'}</Badge>
                </div>
                <p className="mt-2 text-[12px] text-ink-400">
                  시작: {s.def.triggerLabel} · 최근 30일 {formatNumber(count(s.def.key))}건 (완료 {formatNumber(count(s.def.key, 'DONE'))} · 승인 대기 {formatNumber(count(s.def.key, 'AWAITING_APPROVAL'))})
                </p>
                <ActionForm action={saveJourneyAction} submitLabel="저장" variant="secondary" size="sm" className="mt-3">
                  <input type="hidden" name="key" value={s.def.key} />
                  <Checkbox name="enabled" defaultChecked={s.enabled} label="이 자동 안내 사용" />
                  <ol className="mt-1 space-y-1.5 rounded-xl border border-ink-100 p-3">
                    {s.def.steps.map((step, i) => (
                      <li key={step.key} className="text-[12.5px]">
                        <div className="flex items-start gap-2">
                          <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ink-100 text-[11px] font-bold text-ink-600">{i + 1}</span>
                          <div className="min-w-0 flex-1">
                            <p className="font-semibold text-ink-800">{step.label}</p>
                            <p className="text-[12px] leading-relaxed text-ink-500">{step.describe(s.params)}</p>
                            {step.approvable ? (
                              <Checkbox name={`approval_${step.key}`} defaultChecked={s.approvals[step.key]} label="승인 후 보내기" description="승인 대기함에서 확인한 뒤 보냅니다." className="py-1" />
                            ) : null}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ol>
                  {s.def.params.length ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                      {s.def.params.map((p) =>
                        p.type === 'boolean' ? (
                          <Checkbox key={p.key} name={`param_${p.key}`} defaultChecked={Boolean(s.params[p.key])} label={p.label} />
                        ) : (
                          <Field key={p.key} label={`${p.label}${p.unit ? ` (${p.unit})` : ''}`} hint={p.hint}>
                            <Input
                              name={`param_${p.key}`}
                              defaultValue={Array.isArray(s.params[p.key]) ? (s.params[p.key] as number[]).join(', ') : String(s.params[p.key])}
                              inputMode={p.type === 'number' ? 'numeric' : 'text'}
                              aria-label={p.label}
                            />
                          </Field>
                        ),
                      )}
                    </div>
                  ) : null}
                </ActionForm>
              </Card>
            ))}
          </div>
        </section>
      ))}

      <OutboundPanel merchantId={merchantId} />

      <Card className="mt-6">
        <h2 className="text-[16px] font-black text-ink-900">최근 실행</h2>
        {runs.length === 0 ? (
          <p className="mt-2 text-[13px] text-ink-400">아직 실행된 자동 안내가 없습니다.</p>
        ) : (
          <div className="mt-3">
            <Table>
              <thead>
                <tr><Th>시작</Th><Th>자동 안내</Th><Th>후원자</Th><Th>상태</Th><Th>현재 단계</Th><Th>마지막 기록</Th><Th>다음 진행</Th><Th></Th></tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const def = journeyDef(r.journeyKey);
                  const st = STATUS_LABEL[r.status] ?? { label: r.status, tone: 'neutral' as const };
                  const p = r.payerId ? payers.get(r.payerId) : null;
                  const last = r.logs[0];
                  const open = r.status === 'WAITING' || r.status === 'AWAITING_APPROVAL';
                  return (
                    <tr key={r.id}>
                      <Td className="whitespace-nowrap text-[12px]">{formatKst(r.startedAt, false)}</Td>
                      <Td className="font-semibold">{def?.label ?? r.journeyKey}</Td>
                      <Td className="text-[12px]">{p ? `${p.displayName ?? '후원자'} ${p.phoneMasked}` : '-'}</Td>
                      <Td><Badge tone={st.tone}>{st.label}</Badge></Td>
                      <Td className="text-[12px]">{def?.steps[r.stepIndex]?.label ?? (r.status === 'DONE' ? '끝' : '-')}</Td>
                      <Td className="text-[12px] text-ink-500">{last ? `${OUTCOME_LABEL[last.outcome] ?? last.outcome}${last.detail ? ` · ${last.detail}` : ''}` : '-'}</Td>
                      <Td className="whitespace-nowrap text-[12px]">{r.status === 'WAITING' ? formatKst(r.dueAt, false) : '-'}</Td>
                      <Td>{open ? <ActionForm action={cancelJourneyRunAction} submitLabel="멈추기" variant="ghost" size="sm" confirmMessage="이 후원자에 대한 이 자동 안내를 멈춥니다."><input type="hidden" name="id" value={r.id} /></ActionForm> : null}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
        )}
      </Card>
    </>
  );
}
