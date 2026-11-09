import { Badge, Card, StatTile, Table, Td, Th } from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { formatKst } from '@/lib/datetime';
import { formatNumber } from '@/lib/money';
import { noticeStageStats } from '@/server/services/outbound/stage-stats';
import { listUnknownAlimtalk } from '@/server/services/outbound/unknown-resend';
import { coalesceWaitMs, coordinatorEnabled } from '@/server/services/outbound/coordinator';
import { RELATIONAL_WEEKLY_CAP } from '@/server/services/outbound/classify';
import { resendUnknownAction } from '@/app/actions/outbound';

/**
 * 자동 안내 화면의 "통합 발송 관리" 구역 (2026-11-09 D2-5).
 * 최근 30일 안내 단계(요청→접수→전달→열람→완료)와 안내 종류별 완료율, 발송 대기열 현황, 알림톡 결과 미확인 목록(문자로 다시 보내기 1회).
 */
export async function OutboundPanel({ merchantId }: { merchantId: string }) {
  const [stats, unknown] = await Promise.all([noticeStageStats(merchantId), listUnknownAlimtalk(merchantId)]);
  const on = coordinatorEnabled();
  const dash = <span className="text-ink-300">-</span>;
  const n = (v: number | null) => (v === null ? dash : formatNumber(v));

  return (
    <section className="mt-6 space-y-4">
      <Card>
        <h2 className="text-[16px] font-black text-ink-900">안내 전달 단계 (최근 30일)</h2>
        <p className="mt-1 text-[12.5px] leading-relaxed text-ink-500">
          요청(발송 대기열 등록·발송 시도) → 접수(공급자 접수) → 전달(수신 확인) → 열람(링크 첫 열람) → 완료(서명·영수증 정보 등록·결제수단 재등록처럼 안내가 요구한 일).
          열람·완료 기록이 없는 안내는 &quot;-&quot; 로 둡니다.
        </p>
        <div className="mt-3">
          <Table>
            <thead>
              <tr><Th>안내 종류</Th><Th>요청</Th><Th>접수</Th><Th>전달</Th><Th>열람</Th><Th>완료</Th><Th>완료율</Th></tr>
            </thead>
            <tbody>
              {stats.rows.map((r) => (
                <tr key={r.key}>
                  <Td>
                    <span className="font-semibold text-ink-900">{r.label}</span>
                    <Badge tone={r.relational ? 'brand' : 'neutral'} className="ml-1.5">{r.relational ? '정보형' : '거래·요청형'}</Badge>
                  </Td>
                  <Td className="tabular-nums">{n(r.requested)}</Td>
                  <Td className="tabular-nums">{n(r.accepted)}</Td>
                  <Td className="tabular-nums">{n(r.delivered)}</Td>
                  <Td className="tabular-nums">{n(r.opened)}</Td>
                  <Td className="tabular-nums">{n(r.completed)}</Td>
                  <Td className="tabular-nums">{r.completionRate === null ? dash : `${r.completionRate}%`}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="발송 대기 중" value={`${formatNumber(stats.queue.waiting)}건`} tone="brand" sub={on ? `정보성 안내는 ${Math.round(coalesceWaitMs() / 60_000)}분 모아 한 통으로` : '통합 발송 관리 꺼짐 — 바로 발송'} />
        <StatTile label="묶어서 줄인 문자" value={`${formatNumber(stats.queue.saved)}통`} sub="최근 30일" />
        <StatTile label="상한·보류로 건너뜀" value={`${formatNumber(stats.queue.skipped)}건`} sub={`7일 ${RELATIONAL_WEEKLY_CAP}건 상한 · 3번 보류 시`} tone={stats.queue.skipped ? 'warning' : 'neutral'} />
        <StatTile label="발송 실패" value={`${formatNumber(stats.queue.failed)}건`} tone={stats.queue.failed ? 'danger' : 'neutral'} />
      </div>

      <Card>
        <h2 className="text-[16px] font-black text-ink-900">알림톡 결과 미확인</h2>
        <p className="mt-1 text-[12.5px] leading-relaxed text-ink-500">
          알림톡을 접수했지만 2시간 안에 전달 결과를 받지 못한 안내입니다. 카카오톡으로 이미 받았을 수 있어 자동으로 다시 보내지 않습니다.
          후원자에게 꼭 전해야 하면 문자로 한 번 다시 보낼 수 있습니다(본문은 14일 보관).
        </p>
        {unknown.length === 0 ? (
          <p className="mt-3 text-[13px] text-ink-400">결과 미확인 건이 없습니다.</p>
        ) : (
          <div className="mt-3">
            <Table>
              <thead>
                <tr><Th>접수</Th><Th>받는 분</Th><Th>내용</Th><Th></Th></tr>
              </thead>
              <tbody>
                {unknown.map((u) => (
                  <tr key={u.id}>
                    <Td className="whitespace-nowrap text-[12px]">{formatKst(u.acceptedAt ?? u.createdAt, false)}</Td>
                    <Td className="whitespace-nowrap font-mono text-[12px]">{u.phoneMasked}</Td>
                    <Td className="max-w-[420px] text-[12px] text-ink-600"><span className="line-clamp-2">{u.bodyMasked}</span></Td>
                    <Td>
                      {u.manualResentAt ? (
                        <Badge tone="success">문자로 다시 보냄 {formatKst(u.manualResentAt, false)}</Badge>
                      ) : u.canResend ? (
                        <ActionForm action={resendUnknownAction} submitLabel="문자로 다시 보내기" variant="secondary" size="sm" confirmMessage="이 안내를 문자로 한 번 다시 보냅니다. 카카오톡으로 이미 받았다면 두 번 받게 됩니다. 다시 보내기는 한 번만 할 수 있습니다.">
                          <input type="hidden" name="id" value={u.id} />
                        </ActionForm>
                      ) : (
                        <span className="text-[12px] text-ink-400">보관 기간 지남</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </Card>
    </section>
  );
}
