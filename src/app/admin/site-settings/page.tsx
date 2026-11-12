import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, DataRow } from '@/components/ui';
import { BazaarSwitchForm } from '@/components/bazaar/switch-form';
import { requireAdmin } from '@/server/auth';
import { prisma } from '@/server/db';
import { isLiveBazaarEnabled } from '@/server/services/bazaar-settings';
import { unpaidSettlementSummary } from '@/server/services/bazaar-views';
import { formatWon } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import { contractIntegrations } from '@/lib/env';
import { ActionForm } from '@/components/admin/action-form';
import { createCardFeePolicyAction, setRelationshipSwitchAction } from '@/app/actions/admin/contract-integrations';
import { relationshipGloballyEnabled } from '@/server/services/relationship-messages';

export const dynamic = 'force-dynamic';

/**
 * 사이트 설정(최고관리자). 서비스 단위로 켜고 끄는 기능을 모은다.
 * 라이브 바자회 스위치는 꺼져 있어도 이 화면에 남는다(다시 켤 수 있어야 하므로).
 */
export default async function SiteSettingsPage() {
  const admin = await requireAdmin();
  const [enabled, unpaid, row, donations, listed] = await Promise.all([
    isLiveBazaarEnabled(),
    unpaidSettlementSummary(),
    prisma.systemSetting.findUnique({ where: { key: 'live_bazaar.enabled' } }),
    prisma.inKindDonation.count({ where: { status: { notIn: ['CANCELED', 'RETURNED', 'CLOSED'] } } }),
    prisma.bazaarProduct.count({ where: { status: 'LISTED' } }),
  ]);
  const canEdit = admin.adminPermission === 'SUPER_ADMIN';
  // 2026-11-13 5차 L — 관계 안내 스위치 · 계약 연동 상태 · 카드 수수료 정책
  const [relOn, relRow, cardPolicies] = await Promise.all([
    relationshipGloballyEnabled(),
    prisma.systemSetting.findUnique({ where: { key: 'relationship_messages.enabled' } }),
    prisma.cardFeePolicy.findMany({ orderBy: { effectiveFrom: 'desc' }, take: 5 }),
  ]);
  const ci = contractIntegrations();
  const pct = (d: { toString(): string }) => `${(Number(d.toString()) * 100).toFixed(2)}%`;
  return (
    <>
      <PageHeader title="사이트 설정" description="서비스 기능을 켜고 끕니다. 바꾸면 모든 화면에 바로(최대 1초) 반영됩니다." />
      <Card>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>라이브 바자회</CardTitle>
          {enabled ? <Badge tone="success">켜짐</Badge> : <Badge tone="neutral">꺼짐</Badge>}
        </div>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-500">
          켜면 메인 소개 섹션, 공개 소개 페이지, 현물 기부 회원 가입·기부자 콘솔, 기관 콘솔 메뉴, 관리자 메뉴가 모두 나타납니다. 끄면 이 기능들이 모두 사라지고 해당 주소는 404 가 됩니다.
        </p>
        <div className="mt-2 grid gap-1 sm:grid-cols-2">
          <DataRow label="마지막 변경" value={row ? formatKst(row.updatedAt, false) : '변경 이력 없음(기본값 꺼짐)'} />
        </div>
        <div className="mt-4"><BazaarSwitchForm enabled={enabled} canEdit={canEdit} open={{ donations, listed, unpaid: unpaid.count }} /></div>
        <p className="mt-3 text-[12.5px] text-ink-500">
          꺼져 있어도 처리할 수 있는 화면:
          <Link href="/admin/in-kind-settlements" className="ml-1 font-bold text-brand-700 underline">현물 판매 정산</Link> ·
          <Link href="/admin/in-kind-receipts" className="ml-1 font-bold text-brand-700 underline">현물 기부금영수증 정정</Link>
        </p>
        {unpaid.toCarry > 0 ? (
          <p className="mt-3 text-[12.5px] text-ink-500">지급액이 0원 이하인 정산 {unpaid.toCarry}건은 확정(또는 이월) 때 다음 달로 넘어갑니다.</p>
        ) : null}
        {unpaid.count > 0 ? (
          <div className="mt-5 rounded-xl border border-ink-200 px-4 py-3 text-[13px]">
            미지급 현물 판매 정산 <strong>{unpaid.count}건</strong>(확정 {unpaid.confirmed}건) · {formatWon(unpaid.total)}{' '}
            <Link href="/admin/in-kind-settlements" className="ml-1 font-bold text-brand-700 underline">정산 지급 처리</Link>
          </div>
        ) : null}
      </Card>

      <Card className="mt-4">
        <div className="flex items-center justify-between gap-3">
          <CardTitle>관계 확장 안내(광고성)</CardTitle>
          {relOn ? <Badge tone="success">켜짐</Badge> : <Badge tone="neutral">꺼짐</Badge>}
        </div>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-500">
          (선택) 소식 수신 동의자에게만, 기관이 승인한 뒤, 후원자당 월 1회 이하로 문자를 보냅니다. 법무 확인 전에는 끈 채로 둡니다. 끄면 대상 계산·승인 요청·발송이 모두 멈춥니다.
        </p>
        <DataRow label="마지막 변경" value={relRow ? formatKst(relRow.updatedAt, false) : '변경 이력 없음(기본값 꺼짐)'} />
        {canEdit ? (
          <ActionForm action={setRelationshipSwitchAction} submitLabel={relOn ? '끄기' : '켜기'} variant={relOn ? 'secondary' : 'primary'} className="mt-3">
            {relOn ? null : <input type="hidden" name="enabled" value="on" />}
            {relOn ? null : <input name="confirmText" aria-label="확인 문구 입력" placeholder="법무 확인 완료" className="h-10 w-full rounded-xl border border-ink-200 px-3 text-[13px]" />}
          </ActionForm>
        ) : <p className="mt-2 text-[12.5px] text-ink-400">최고관리자만 바꿀 수 있습니다.</p>}
      </Card>

      <Card className="mt-4">
        <CardTitle>계약이 필요한 연동</CardTitle>
        <p className="mt-1 text-[12.5px] text-ink-500">환경변수로만 바뀝니다. 운영에서 켰는데 mock 이면 서버가 뜨지 않습니다.</p>
        <div className="mt-2 grid gap-1 sm:grid-cols-2">
          <DataRow label="본인인증" value={`${ci.identityProvider}${ci.identityProvider === 'mock' ? ' (모의 — 실제 확인 아님)' : ''} · 사용: ${[ci.identityRequired.receipt && '영수증 정보', ci.identityRequired.esign && '전자서명', ci.identityRequired.recurring && '정기 해지·변경'].filter(Boolean).join(', ') || '없음'}`} />
          <DataRow label="시점확인(TSA)" value={ci.timestampProvider === 'mock' ? '시점확인 미연동' : ci.timestampProvider} />
          <DataRow label="카드 결제" value={`${ci.cardEnabled ? '켜짐' : '꺼짐'} · ${ci.cardProvider}${ci.cardProvider === 'mock' ? ' (모의)' : ''} · 일시후원만`} />
          <DataRow label="계좌 자동 조회" value={`${ci.bankFeedEnabled ? '켜짐' : '꺼짐'} · ${ci.bankFeedProvider}${ci.bankFeedProvider === 'mock' ? ' (연동 안 됨)' : ''}`} />
          <DataRow label="지난번 방법으로 후원" value={ci.moQuickRepeat ? '켜짐(PIN 은 그대로)' : '꺼짐'} />
        </div>
        <h3 className="mt-4 text-[13px] font-bold text-ink-800">카드 결제 수수료 정책</h3>
        <p className="text-[12px] text-ink-500">계좌 결제 수수료와 따로 둡니다. 정책이 없으면 카드 선택지가 보이지 않습니다.</p>
        {cardPolicies.length ? (
          <ul className="mt-1 text-[12.5px] text-ink-700">
            {cardPolicies.map((p) => (
              <li key={p.id}>{p.scope === 'GLOBAL' ? '전체' : `기관 ${p.merchantId}`} · 결제 {pct(p.pgFeeRate)} + {p.pgFixedFee.toString()}원 · 플랫폼 {pct(p.platformFeeRate)} · {p.vatIncluded ? '부가세 포함' : '부가세 별도'} · {formatKst(p.effectiveFrom, false)}~{p.effectiveTo ? formatKst(p.effectiveTo, false) : ''}</li>
            ))}
          </ul>
        ) : <p className="mt-1 text-[12.5px] text-ink-400">등록된 카드 정책이 없습니다.</p>}
        <ActionForm action={createCardFeePolicyAction} submitLabel="카드 수수료 정책 등록" className="mt-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <input name="merchantCode" aria-label="기관 코드" placeholder="기관 코드(비우면 전체)" className="h-10 rounded-xl border border-ink-200 px-3 text-[13px]" />
            <input name="effectiveFrom" type="date" aria-label="적용 시작일" className="h-10 rounded-xl border border-ink-200 px-3 text-[13px]" />
            <input name="pgFeeRate" placeholder="카드 결제 수수료 %" className="h-10 rounded-xl border border-ink-200 px-3 text-[13px]" />
            <input name="platformFeeRate" placeholder="플랫폼 수수료 %" className="h-10 rounded-xl border border-ink-200 px-3 text-[13px]" />
            <input name="pgFixedFee" placeholder="건당 고정비(원)" defaultValue="0" className="h-10 rounded-xl border border-ink-200 px-3 text-[13px]" />
            <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" name="vatIncluded" defaultChecked /> 부가세 포함 요율</label>
          </div>
        </ActionForm>
      </Card>
    </>
  );
}
