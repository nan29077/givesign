import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, Notice } from '@/components/ui';
import { requireMerchant } from '@/server/auth';
import { formatKst } from '@/lib/datetime';
import { RelationshipSettingForm } from '@/components/relationship/forms';
import { RELATIONSHIP_KINDS, relationshipGloballyEnabled, relationshipOverview, relationshipPreview, type RelationshipKind } from '@/server/services/relationship-messages';
import { prisma } from '@/server/db';

export const dynamic = 'force-dynamic';

/**
 * 관계 확장 안내(광고성, 2026-11-13 5차 L4). 전역 스위치가 꺼져 있으면 "법무 확인 후 켤 수 있습니다" 만 보이고
 * 아무 대상도 계산하지 않는다.
 */
export default async function StudioRelationshipPage() {
  const user = await requireMerchant();
  const on = await relationshipGloballyEnabled();
  if (!on) {
    return (
      <>
        <PageHeader title="관계 안내" description="(선택) 소식 수신에 동의한 후원자에게 보내는 안내입니다." />
        <Card>
          <p className="text-[15px] font-bold text-ink-900">법무 확인 후 켤 수 있습니다</p>
          <p className="mt-1 text-[13.5px] text-ink-500">지금은 동의만 모으는 단계입니다. 이 안내로 보내는 문자는 없습니다.</p>
        </Card>
      </>
    );
  }
  const merchant = await prisma.merchantProfile.findUniqueOrThrow({ where: { id: user.merchantId }, select: { displayName: true, code: true } });
  const { setting, batches } = await relationshipOverview(user.merchantId);
  const options = (Object.keys(RELATIONSHIP_KINDS) as RelationshipKind[]).map((k) => ({ key: k, label: RELATIONSHIP_KINDS[k].label, rule: RELATIONSHIP_KINDS[k].rule }));
  return (
    <>
      <PageHeader title="관계 안내" description="동의한 후원자에게만, 담당자가 승인한 뒤, 후원자당 월 1회 이하로 문자로 보냅니다(광고 표기·무료 수신 거부 포함)." />
      <div className="space-y-4">
        {setting?.pausedAt ? (
          <Notice tone="danger" title="자동 중지됨">{setting.pauseReason ?? '수신 거부율 기준을 넘어 멈췄습니다.'} · {formatKst(setting.pausedAt, false)} — 문안·대상을 확인한 뒤 다시 켤 수 있습니다.</Notice>
        ) : null}
        <Card>
          <CardTitle>설정</CardTitle>
          <p className="mb-3 mt-1 text-[13px] text-ink-500">켜면 매주 한 번 대상 묶음(대상 수·문안·표본)이 <Link href="/studio/inbox" className="font-bold text-brand-700">승인 대기함</Link>에 올라옵니다. 승인해야 보냅니다.</p>
          <RelationshipSettingForm enabled={Boolean(setting?.enabled)} kinds={setting?.kinds ?? []} options={options} />
        </Card>
        <Card>
          <CardTitle>문안 미리보기</CardTitle>
          <ul className="mt-2 space-y-2">
            {options.map((o) => (
              <li key={o.key} className="rounded-xl bg-ink-50 p-3 text-[13px] leading-relaxed text-ink-800">
                <p className="font-bold">{o.label}</p>
                <p className="mt-1 whitespace-pre-wrap break-words">{relationshipPreview(o.key as RelationshipKind, merchant)}</p>
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardTitle>최근 묶음</CardTitle>
          {batches.length === 0 ? <p className="mt-2 text-[13px] text-ink-500">아직 없습니다.</p> : (
            <ul className="mt-2 divide-y divide-ink-100">
              {batches.map((b) => (
                <li key={b.id} className="py-2 text-[13px]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-ink-900">{b.title}</span>
                    <Badge tone={b.status === 'APPROVED' ? 'success' : b.status === 'PENDING' ? 'warning' : 'neutral'}>{b.status === 'PENDING' ? '승인 대기' : b.status === 'APPROVED' ? '승인됨' : b.status === 'REJECTED' ? '반려' : '만료'}</Badge>
                  </div>
                  <p className="mt-0.5 text-ink-500">{formatKst(b.createdAt, false)} · 보냄 {b.stats.sent}명 · 7일 수신 거부 {(b.stats.optOutRate * 100).toFixed(1)}% · 7일 해지 {(b.stats.cancelRate * 100).toFixed(1)}%</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
