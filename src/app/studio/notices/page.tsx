import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { env } from '@/lib/env';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, Checkbox, Field, Input, Notice, Select, StatTile, Table, Td, Th } from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { addDays, formatKst, kstStartOfDay } from '@/lib/datetime';
import { formatNumber } from '@/lib/money';
import { alimtalkIsMock } from '@/server/adapters/alimtalk';
import { ALIMTALK_STATUS_LABEL, alimtalkTemplateOptions, getAlimtalkChannel } from '@/server/services/alimtalk';
import { previousMonthKey } from '@/server/services/monthly-notice';
import { doneeVerified } from '@/server/services/receipts';
import { runNoticeNowAction, saveAlimtalkAction, saveNoticeSettingsAction } from '@/app/actions/automation';

export const dynamic = 'force-dynamic';

/**
 * 알림톡 · 월간 안내.
 *
 * 1) 카카오 알림톡 채널: 기관이 채널 아이디·발신프로필 키·승인 템플릿 코드를 등록 → 관리자가 카카오 승인을 확인하면 사용 중.
 *    사용 중이 아니거나 템플릿 코드가 없는 안내는 문자로 나간다. 알림톡이 실패해도 같은 내용이 문자로 대체된다.
 * 2) 월간 안내: 매월 1일 지난달 후원자에게 내역·누적·영수증 링크. 영수증 주기(연 1회·매월)도 여기서 고른다.
 */
export default async function StudioNoticesPage() {
  const { merchantId } = await requireMerchant();
  const [merchant, channel, runs, monthStats] = await Promise.all([
    prisma.merchantProfile.findUniqueOrThrow({ where: { id: merchantId } }),
    getAlimtalkChannel(merchantId),
    prisma.noticeRun.findMany({ where: { merchantId }, orderBy: { startedAt: 'desc' }, take: 12 }),
    prisma.mtOutboundMessage.groupBy({
      by: ['channel', 'fallback'],
      where: { merchantId, createdAt: { gte: addDays(kstStartOfDay(), -30) }, status: 'SENT' },
      _count: { _all: true },
    }),
  ]);
  const options = alimtalkTemplateOptions();
  const statCount = (ch: string, fb?: boolean) => monthStats.filter((m) => m.channel === ch && (fb === undefined || m.fallback === fb)).reduce((a, m) => a + m._count._all, 0);
  const status = channel?.status ?? 'NOT_CONNECTED';
  const receiptReady = doneeVerified(merchant);

  return (
    <>
      <PageHeader title="알림톡·월간 안내" description="정기 출금·영수증·약정서·봉사 안내를 카카오 알림톡으로 보내고, 매월 1일 지난달 후원 내역을 자동으로 알려 드립니다. 알림톡을 쓸 수 없을 때는 문자로 나갑니다." />

      {!env.automation.alimtalkEnabled ? (
        <Notice tone="neutral" title="알림톡 발송이 꺼져 있습니다">지금은 모든 안내가 문자로 나갑니다. 채널 정보는 미리 등록해 둘 수 있습니다.</Notice>
      ) : alimtalkIsMock() ? (
        <Notice tone="warning" title="알림톡 mock">알림톡 중계사 연동 전입니다. 사용 중 채널이어도 실제 카카오톡은 나가지 않고 발송 기록만 남습니다.</Notice>
      ) : null}

      <div className="my-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="알림톡 채널" value={ALIMTALK_STATUS_LABEL[status]} tone={status === 'ACTIVE' ? 'success' : status === 'PENDING' ? 'warning' : 'neutral'} />
        <StatTile label="최근 30일 알림톡" value={`${formatNumber(statCount('ALIMTALK'))}건`} tone="brand" />
        <StatTile label="최근 30일 문자" value={`${formatNumber(statCount('SMS'))}건`} sub={`알림톡 실패 → 문자 대체 ${formatNumber(statCount('SMS', true))}건`} />
        <StatTile label="다음 월간 안내" value="매월 1일" sub={merchant.monthlyNoticeEnabled ? '켜짐' : '꺼짐'} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr]">
        <Card>
          <h2 className="text-[16px] font-black text-ink-900">카카오 알림톡 채널</h2>
          <p className="mt-1.5 mb-4 text-[13px] leading-relaxed text-ink-500">
            카카오 비즈니스에서 채널을 만들고 발신프로필 키를 받은 뒤, 아래 안내별로 카카오에 템플릿을 등록·승인받아 코드를 적어 주세요.
            알림톡은 <b>정보성 안내</b>만 보낼 수 있어 후원 권유(광고) 템플릿은 목록에 없습니다. 저장하면 관리자 확인 대기 상태가 됩니다.
          </p>
          {channel?.note ? <div className="mb-3"><Notice tone="brand" title="관리자 메모">{channel.note}</Notice></div> : null}
          <ActionForm action={saveAlimtalkAction} submitLabel="채널 정보 저장">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="카카오톡 채널 아이디" required><Input name="channelId" defaultValue={channel?.channelId ?? ''} placeholder="@햇살복지관" /></Field>
              <Field label="발신프로필 키" hint={channel?.senderKeyMasked ? `등록됨 ${channel.senderKeyMasked} — 바꿀 때만 입력` : '암호화해 저장합니다.'}>
                <Input name="senderKey" autoComplete="off" placeholder={channel ? '변경 시에만 입력' : '발신프로필 키'} />
              </Field>
            </div>
            <div className="rounded-xl border border-ink-100">
              {options.map((o) => (
                <div key={o.code} className="grid gap-2 border-b border-ink-100 p-3 last:border-0 sm:grid-cols-[1fr_200px] sm:items-center">
                  <div>
                    <p className="text-[13px] font-bold text-ink-900">{o.label}</p>
                    <p className="text-[11.5px] leading-relaxed text-ink-400">{o.sample}</p>
                  </div>
                  <Input name={`tpl_${o.code}`} defaultValue={channel?.templateCodes[o.code] ?? ''} placeholder="승인 템플릿 코드" className="h-10" />
                </div>
              ))}
            </div>
          </ActionForm>
        </Card>

        <div className="space-y-4">
          <Card>
            <h2 className="text-[16px] font-black text-ink-900">월간 후원 안내 · 영수증 주기</h2>
            <p className="mt-1.5 mb-4 text-[13px] leading-relaxed text-ink-500">매월 1일 오전, 지난달 후원하신 분께 횟수·금액·올해 누적과 내역·영수증 링크를 보냅니다. 후원자는 마이페이지에서 기관별로 수신을 끌 수 있습니다.</p>
            <ActionForm action={saveNoticeSettingsAction} submitLabel="설정 저장" variant="secondary">
              <Checkbox name="monthlyNoticeEnabled" defaultChecked={merchant.monthlyNoticeEnabled} label="월간 후원 안내 보내기" />
              <Field label="기부금영수증 발급 주기" hint="연 1회 합산을 권합니다. 매월을 고르면 월간 안내 직전에 아직 발급하지 않은 올해 후원 건으로 영수증을 발급합니다(공익법인 확인·영수증 정보 등록 후원자만).">
                <Select name="receiptCycle" defaultValue={merchant.receiptCycle}>
                  <option value="YEARLY">연 1회 합산 (연말정산 기준)</option>
                  <option value="MONTHLY">매월 발급</option>
                </Select>
              </Field>
              {merchant.receiptCycle === 'MONTHLY' && !receiptReady ? <Notice tone="warning">공익법인 지정이 관리자 확인 전이라 월별 영수증은 건너뛰고 안내만 보냅니다.</Notice> : null}
            </ActionForm>
          </Card>
          <Card>
            <h2 className="text-[16px] font-black text-ink-900">지금 보내기</h2>
            <p className="mt-1.5 mb-3 text-[13px] text-ink-500">{previousMonthKey()} 안내를 배치보다 먼저 보냅니다. 같은 달은 한 번만 나가므로 배치가 다시 보내지 않습니다.</p>
            <ActionForm action={runNoticeNowAction} submitLabel={`${previousMonthKey()} 안내 보내기`} variant="secondary" confirmMessage="지난달 후원자에게 월간 안내를 지금 보냅니다. 같은 달 안내는 다시 보낼 수 없습니다." />
          </Card>
        </div>
      </div>

      <Card className="mt-4">
        <h2 className="text-[16px] font-black text-ink-900">월간 안내 기록</h2>
        {runs.length === 0 ? <p className="mt-2 text-[13px] text-ink-400">아직 보낸 월간 안내가 없습니다.</p> : (
          <div className="mt-3"><Table>
            <thead><tr><Th>대상 월</Th><Th>대상</Th><Th>발송</Th><Th>알림톡</Th><Th>문자 대체</Th><Th>제외</Th><Th>실패</Th><Th>영수증 발급</Th><Th>완료</Th></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <Td className="font-semibold">{r.monthKey}</Td>
                  <Td className="tabular-nums">{r.recipientCount}</Td>
                  <Td className="tabular-nums">{r.sentCount}</Td>
                  <Td className="tabular-nums">{r.alimtalkCount}</Td>
                  <Td className="tabular-nums">{r.fallbackCount}</Td>
                  <Td className="tabular-nums">{r.skippedCount}</Td>
                  <Td className="tabular-nums">{r.failedCount ? <Badge tone="danger">{r.failedCount}</Badge> : 0}</Td>
                  <Td className="tabular-nums">{r.receiptsIssued}</Td>
                  <Td className="whitespace-nowrap">{r.status === 'DONE' ? formatKst(r.finishedAt, false) : <Badge tone="warning">진행 중</Badge>}</Td>
                </tr>
              ))}
            </tbody>
          </Table></div>
        )}
      </Card>
    </>
  );
}
