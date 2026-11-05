import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Card, CardTitle, Checkbox, DataRow, Field, Input, LinkButton, Notice, StatTile, Textarea } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { BazaarSubNav } from '@/components/bazaar/sub-nav';
import { LabelBadge } from '@/components/bazaar/status-badge';
import { prisma } from '@/server/db';
import { studioBazaarContext, studioTabs } from '@/server/studio-bazaar-context';
import { getBazaarConfig } from '@/server/services/bazaar-settings';
import { issuerReadiness } from '@/server/services/receipts';
import { applyParticipationAction } from '@/app/actions/bazaar-studio';
import { CONSIGNMENT_TEXT, CONSIGNMENT_VERSION, participationLabel } from '@/lib/bazaar';
import { formatWon } from '@/lib/money';
import { formatKst } from '@/lib/datetime';

export const dynamic = 'force-dynamic';

export default async function StudioBazaarHome() {
  const { merchant, participation } = await studioBazaarContext();
  const mid = merchant.merchantId;
  const now = new Date();
  const [profile, matches, valuating, inspected, lives, onSale, unpaid, cfg] = await Promise.all([
    prisma.merchantProfile.findUniqueOrThrow({ where: { id: mid } }),
    prisma.inKindMatch.count({ where: { merchantId: mid, status: 'PROPOSED', deadline: { gte: now } } }),
    prisma.inKindDonation.count({ where: { merchantId: mid, status: 'VALUATING' } }),
    prisma.inKindDonation.count({ where: { merchantId: mid, status: 'INSPECTED' } }),
    prisma.bazaarLive.count({ where: { merchantId: mid, status: 'PROPOSED' } }),
    prisma.bazaarProduct.count({ where: { merchantId: mid, status: 'LISTED' } }),
    prisma.bazaarSettlement.aggregate({ where: { merchantId: mid, status: { in: ['DRAFT', 'CONFIRMED'] } }, _sum: { payout: true } }),
    getBazaarConfig(),
  ]);
  const readiness = issuerReadiness(profile);
  const approved = participation?.status === 'APPROVED';

  return (
    <>
      <PageHeader title="라이브 바자회" description="기부받은 물품을 기브싸인이 대신 판매(위탁판매)해 후원금으로 만들어 드립니다. 기관이 할 일은 매칭 수락·가액 확정·검수 확정·편성 승인 네 가지입니다." />
      <BazaarSubNav items={studioTabs({ inbox: matches + valuating + inspected, lives })} current="/studio/bazaar" />

      {!readiness.ok ? (
        <div className="mb-4"><Notice tone="warning" title="기부금영수증 발급 준비가 필요합니다">
          매칭과 영수증 발급은 기관 정보가 갖춰져야 합니다: {readiness.missing.join(', ')}. <Link href="/studio/profile" className="font-bold underline">기관 정보</Link>에서 채워 주세요.
        </Notice></div>
      ) : null}

      {approved ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="매칭 제안(응답 필요)" value={`${matches}건`} tone={matches ? 'warning' : 'neutral'} />
          <StatTile label="가액 협의 중" value={`${valuating}건`} tone={valuating ? 'warning' : 'neutral'} />
          <StatTile label="검수 확정 대기" value={`${inspected}건`} tone={inspected ? 'warning' : 'neutral'} />
          <StatTile label="정산 예정" value={formatWon(unpaid._sum.payout ?? 0n)} sub={`판매 중 상품 ${onSale}개`} tone="brand" />
        </div>
      ) : null}

      <Card className="mt-5">
        <div className="flex items-center justify-between gap-2">
          <CardTitle>참여 상태</CardTitle>
          {participation ? <LabelBadge map={participationLabel} value={participation.status} /> : null}
        </div>
        {participation ? (
          <div className="mt-2 grid gap-1 sm:grid-cols-2">
            <DataRow label="위탁판매 동의" value={`${participation.consignmentName} · ${formatKst(participation.consignmentAgreedAt, false)} (판 ${participation.consignmentVersion})`} />
            <DataRow label="통신판매업 신고번호" value={participation.mailOrderRegNo ?? '미입력'} />
            {participation.note ? <DataRow label="운영자 메모" value={participation.note} /> : null}
          </div>
        ) : <p className="mt-2 text-[13px] text-ink-500">아직 참여하지 않았습니다. 아래 위탁판매 내용을 확인하고 신청해 주세요.</p>}

        {participation?.status !== 'SUSPENDED' ? (
          <div className="mt-4">
            {!approved ? (
              <ol className="mb-3 list-decimal space-y-1 rounded-xl bg-ink-50 py-3 pl-8 pr-4 text-[13px] leading-relaxed text-ink-700">
                {CONSIGNMENT_TEXT.map((t) => <li key={t}>{t.replace('기본 30%', `현재 ${cfg.feeRatePercent}%`)}</li>)}
              </ol>
            ) : null}
            <ActionForm action={applyParticipationAction} submitLabel={approved ? '정보 저장' : participation ? '다시 신청' : '위탁판매에 동의하고 참여 신청'}>
              {!approved ? (
                <>
                  <Field label="동의 담당자 이름" required><Input name="consignmentName" required maxLength={30} defaultValue={profile.contactName ?? ''} /></Field>
                  <Checkbox name="agree" label={`위 위탁판매 내용(판 ${CONSIGNMENT_VERSION})에 동의합니다.`} />
                </>
              ) : (
                <><input type="hidden" name="consignmentName" value={participation?.consignmentName ?? ''} /><input type="hidden" name="agree" value="on" /></>
              )}
              <Field label="필요한 물품(선택)" hint="매칭 때 참고합니다. 예: 생필품, 아동 도서, 겨울 의류"><Textarea name="neededItems" rows={2} maxLength={1000} defaultValue={participation?.neededItems ?? ''} /></Field>
              <Field label="통신판매업 신고번호(선택)" hint="위탁판매 표기에 함께 적습니다."><Input name="mailOrderRegNo" maxLength={40} defaultValue={participation?.mailOrderRegNo ?? ''} /></Field>
            </ActionForm>
          </div>
        ) : <div className="mt-3"><Notice tone="danger">참여가 정지되었습니다. 고객센터로 문의해 주세요.</Notice></div>}
      </Card>

      {approved ? (
        <div className="mt-5 flex flex-wrap gap-2">
          <LinkButton href="/studio/bazaar/donations">기부 접수함 열기</LinkButton>
          <LinkButton href="/api/bazaar/export?kind=ledger" variant="secondary">현물 기부 대장 내려받기(CSV)</LinkButton>
        </div>
      ) : null}
    </>
  );
}
