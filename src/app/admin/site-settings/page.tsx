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
    </>
  );
}
