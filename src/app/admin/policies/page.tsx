import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, EmptyState, Notice, SectionTitle, StatTile } from '@/components/ui';
import { AdminField, AdminInput, AdminSelect, MerchantOptions } from '@/components/admin/controls';
import { ActionButton, ActionForm } from '@/components/admin/action-form';
import { saveLimitPolicy, toggleLimitPolicy } from '@/app/actions/admin/policy';
import { canManageMoney } from '@/components/admin/constants';
import { prisma } from '@/server/db';
import { requireAdmin } from '@/server/auth';
import { FALLBACK_POLICY } from '@/server/services/limits';
import { formatWon, formatNumber } from '@/lib/money';
import { formatKst, kstDateKey } from '@/lib/datetime';

export const dynamic = 'force-dynamic';

interface LimitValues {
  defaultAmount: string;
  minAmount: string;
  maxAmount: string;
  payerDailyLimit: string;
  payerMonthlyLimit: string;
  perMerchantDailyLimit: string;
  payerDailyMaxCount: string;
  velocityWindowSec: string;
  velocityMaxCount: string;
  cooldownAfterCount: string;
  cooldownSec: string;
  failureLockThreshold: string;
  newPayerFirstDayLimit: string;
  manualReviewAmount: string;
}

const fallbackValues: LimitValues = {
  defaultAmount: FALLBACK_POLICY.defaultAmount.toString(),
  minAmount: FALLBACK_POLICY.minAmount.toString(),
  maxAmount: FALLBACK_POLICY.maxAmount.toString(),
  payerDailyLimit: FALLBACK_POLICY.payerDailyLimit.toString(),
  payerMonthlyLimit: FALLBACK_POLICY.payerMonthlyLimit.toString(),
  perMerchantDailyLimit: FALLBACK_POLICY.perMerchantDailyLimit.toString(),
  payerDailyMaxCount: String(FALLBACK_POLICY.payerDailyMaxCount),
  velocityWindowSec: String(FALLBACK_POLICY.velocityWindowSec),
  velocityMaxCount: String(FALLBACK_POLICY.velocityMaxCount),
  cooldownAfterCount: String(FALLBACK_POLICY.cooldownAfterCount),
  cooldownSec: String(FALLBACK_POLICY.cooldownSec),
  failureLockThreshold: String(FALLBACK_POLICY.failureLockThreshold),
  newPayerFirstDayLimit: FALLBACK_POLICY.newPayerFirstDayLimit.toString(),
  manualReviewAmount: FALLBACK_POLICY.manualReviewAmount.toString(),
};

function LimitFields({ v }: { v: LimitValues }) {
  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      <AdminField label="기본 결제 금액 (원)" hint="문자 1건당 기본 결제 금액">
        <AdminInput name="defaultAmount" inputMode="numeric" defaultValue={v.defaultAmount} required />
      </AdminField>
      <AdminField label="1회 최소 (원)">
        <AdminInput name="minAmount" inputMode="numeric" defaultValue={v.minAmount} required />
      </AdminField>
      <AdminField label="1회 최대 (원)">
        <AdminInput name="maxAmount" inputMode="numeric" defaultValue={v.maxAmount} required />
      </AdminField>
      <AdminField label="후원자 1일 한도 (원)">
        <AdminInput name="payerDailyLimit" inputMode="numeric" defaultValue={v.payerDailyLimit} required />
      </AdminField>
      <AdminField label="후원자 1개월 한도 (원)">
        <AdminInput name="payerMonthlyLimit" inputMode="numeric" defaultValue={v.payerMonthlyLimit} required />
      </AdminField>
      <AdminField label="사회복지기관별 1일 한도 (원)">
        <AdminInput name="perMerchantDailyLimit" inputMode="numeric" defaultValue={v.perMerchantDailyLimit} required />
      </AdminField>
      <AdminField label="1인 1일 최대 건수" hint="금액과 별개로 하루 결제 건수를 제한">
        <AdminInput name="payerDailyMaxCount" inputMode="numeric" defaultValue={v.payerDailyMaxCount} required />
      </AdminField>
      <AdminField label="속도 제한 구간 (초)" hint="이 시간 안의 건수를 제한">
        <AdminInput name="velocityWindowSec" inputMode="numeric" defaultValue={v.velocityWindowSec} required />
      </AdminField>
      <AdminField label="속도 제한 최대 건수">
        <AdminInput name="velocityMaxCount" inputMode="numeric" defaultValue={v.velocityMaxCount} required />
      </AdminField>
      <AdminField label="연속 결제 기준 건수" hint="이 건수를 넘기면 대기 부여">
        <AdminInput name="cooldownAfterCount" inputMode="numeric" defaultValue={v.cooldownAfterCount} required />
      </AdminField>
      <AdminField label="연속 결제 대기 (초)">
        <AdminInput name="cooldownSec" inputMode="numeric" defaultValue={v.cooldownSec} required />
      </AdminField>
      <AdminField label="결제 실패 허용 (회)" hint="초과 시 자동 잠금">
        <AdminInput name="failureLockThreshold" inputMode="numeric" defaultValue={v.failureLockThreshold} required />
      </AdminField>
      <AdminField label="신규 후원자 첫날 한도 (원)">
        <AdminInput name="newPayerFirstDayLimit" inputMode="numeric" defaultValue={v.newPayerFirstDayLimit} required />
      </AdminField>
      <AdminField label="수동 검수 기준 (원)" hint="이 금액 이상이면 검수 대상">
        <AdminInput name="manualReviewAmount" inputMode="numeric" defaultValue={v.manualReviewAmount} required />
      </AdminField>
    </div>
  );
}

export default async function AdminPoliciesPage() {
  // 레이아웃 가드에만 기대지 않는다. App Router 는 layout 과 page 를 함께 렌더하므로
  // 비관리자 요청에서도 이 페이지의 조회가 실행될 수 있다(스튜디오·마이페이지와 같은 규약).
  const me = await requireAdmin();
  // 서버 액션과 같은 기준으로 화면의 변경 컨트롤을 잠근다(눌러야 알게 되는 죽은 버튼 방지).
  const canEdit = canManageMoney(me.adminPermission);

  const [policies, merchants] = await Promise.all([
    prisma.chargeLimitPolicy.findMany({
      orderBy: [{ active: 'desc' }, { scope: 'asc' }, { effectiveFrom: 'desc' }],
      take: 50,
      select: {
        id: true, scope: true, merchantId: true, payerId: true, active: true,
        effectiveFrom: true, effectiveTo: true, updatedAt: true,
        defaultAmount: true, minAmount: true, maxAmount: true,
        payerDailyLimit: true, payerMonthlyLimit: true, perMerchantDailyLimit: true, payerDailyMaxCount: true,
        velocityWindowSec: true, velocityMaxCount: true, cooldownAfterCount: true, cooldownSec: true,
        failureLockThreshold: true, newPayerFirstDayLimit: true, manualReviewAmount: true,
        merchant: { select: { id: true, displayName: true, code: true } },
      },
    }),
    prisma.merchantProfile.findMany({
      where: { status: 'APPROVED' },
      orderBy: { displayName: 'asc' },
      select: { id: true, displayName: true, code: true },
    }),
  ]);

  // 적용 여부는 active 플래그가 아니라 시행 기간으로 판단한다(resolvePolicy 와 같은 기준).
  // active 는 "수동으로 마감했는가" 만 뜻한다.
  const now = new Date();
  const isEffective = (p: { active: boolean; effectiveFrom: Date; effectiveTo: Date | null }) =>
    p.active && p.effectiveFrom <= now && (p.effectiveTo === null || p.effectiveTo > now);
  const isScheduled = (p: { active: boolean; effectiveFrom: Date }) => p.active && p.effectiveFrom > now;

  const globalActive = policies.find((p) => p.scope === 'GLOBAL' && isEffective(p));
  const payerScoped = policies.filter((p) => p.scope === 'PAYER').length;
  const merchantScoped = policies.filter((p) => p.scope === 'MERCHANT').length;

  return (
    <>
      <PageHeader
        title="한도 정책"
        description="정책 우선순위는 후원자(PAYER) → 사회복지기관(MERCHANT) → 전역(GLOBAL) 순으로 적용됩니다."
      />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile
          label="전역 1일 한도"
          value={formatWon(globalActive?.payerDailyLimit ?? FALLBACK_POLICY.payerDailyLimit)}
          sub={globalActive ? '지금 적용 중인 전역 정책' : '적용 중인 정책 없음 · 코드 기본값'}
          tone="brand"
        />
        <StatTile
          label="전역 1회 범위"
          value={`${formatWon(globalActive?.minAmount ?? FALLBACK_POLICY.minAmount)} ~ ${formatWon(globalActive?.maxAmount ?? FALLBACK_POLICY.maxAmount)}`}
        />
        <StatTile label="사회복지기관 정책" value={formatNumber(merchantScoped)} />
        <StatTile label="후원자 정책" value={formatNumber(payerScoped)} />
      </div>

      <Notice tone="warning" title="한도 값 변경은 즉시 반영됩니다">
        저장 즉시 새로 들어오는 문자에 적용됩니다. 변경 전/후 값은 모두 감사로그에 기록되며, 한도를 크게 올릴 때는
        이상거래 탐지 기준(수동 검수 금액)도 함께 검토해 주세요.
      </Notice>

      <section className="mt-5">
        <SectionTitle
          title="새 정책 등록"
          description="전역 정책은 기간이 겹치지 않아야 합니다. 시행일을 미래로 두면 그날까지 현행 정책이 그대로 적용됩니다."
        />
        <Card>
          <ActionForm disabled={!canEdit} action={saveLimitPolicy} submitLabel="정책 등록" confirm="새 한도 정책을 등록합니다.">
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              <AdminField label="적용 범위">
                <AdminSelect name="scope" defaultValue="MERCHANT">
                  <option value="GLOBAL">전역 (GLOBAL)</option>
                  <option value="MERCHANT">사회복지기관 (MERCHANT)</option>
                  <option value="PAYER">후원자 (PAYER)</option>
                </AdminSelect>
              </AdminField>
              <AdminField label="사회복지기관" hint="MERCHANT 범위일 때만 사용">
                <AdminSelect name="merchantId" defaultValue="">
                  <MerchantOptions merchants={merchants} allLabel="선택 안 함" />
                </AdminSelect>
              </AdminField>
              <AdminField label="후원자 ID" hint="PAYER 범위일 때만 사용. 후원자 상세 화면의 ID">
                <AdminInput name="payerId" placeholder="01JXXXXXXXXXXXXXXXXXXXXXXX" />
              </AdminField>
              <AdminField label="적용 시작일 (KST)">
                <AdminInput type="date" name="effectiveFrom" defaultValue={kstDateKey()} />
              </AdminField>
            </div>
            <LimitFields v={fallbackValues} />
            <label className="flex items-center gap-2 text-[13px] text-ink-700">
              <input type="checkbox" name="active" defaultChecked className="h-4 w-4 rounded border-ink-300" />
              등록 즉시 활성화
            </label>
          </ActionForm>
        </Card>
      </section>

      <section className="mt-6">
        <SectionTitle title="등록된 정책" description="최대 50건까지 표시합니다." />
        {policies.length === 0 ? (
          <EmptyState
            title="등록된 한도 정책이 없습니다"
            description="정책이 없으면 코드 기본값(1일 10만원 / 1개월 100만원)이 적용됩니다."
          />
        ) : (
          <div className="space-y-4">
            {policies.map((p) => (
              <Card key={p.id}>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <CardTitle>
                      {p.scope === 'GLOBAL'
                        ? '전역 정책'
                        : p.scope === 'MERCHANT'
                          ? `사회복지기관 정책 · ${p.merchant?.displayName ?? p.merchantId ?? '-'}`
                          : `후원자 정책 · ${p.payerId ?? '-'}`}
                    </CardTitle>
                    {!p.active ? (
                      <Badge tone="neutral">마감</Badge>
                    ) : isScheduled(p) ? (
                      <Badge tone="warning">시행 예정</Badge>
                    ) : isEffective(p) ? (
                      <Badge tone="success">적용 중</Badge>
                    ) : (
                      <Badge tone="neutral">지난 정책</Badge>
                    )}
                    {p.scope === 'MERCHANT' && p.merchant ? (
                      <Link href={`/admin/merchants/${p.merchant.id}`} className="text-[12px] font-semibold text-brand-700">
                        사회복지기관 상세
                      </Link>
                    ) : null}
                    {p.scope === 'PAYER' && p.payerId ? (
                      <Link href={`/admin/payers/${p.payerId}`} className="text-[12px] font-semibold text-brand-700">
                        후원자 상세
                      </Link>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-ink-400">
                      적용 {formatKst(p.effectiveFrom, false)} ~{' '}
                      {p.effectiveTo ? formatKst(p.effectiveTo, false) : '진행 중'} · 수정{' '}
                      {formatKst(p.updatedAt, false)}
                    </span>
                    <ActionButton disabled={!canEdit}
                      action={toggleLimitPolicy}
                      values={{ id: p.id }}
                      label={p.active ? '비활성화' : '활성화'}
                      variant={p.active ? 'danger' : 'secondary'}
                      confirm={p.active ? '이 정책을 비활성화합니다.' : '이 정책을 활성화합니다.'}
                    />
                  </div>
                </div>

                <ActionForm disabled={!canEdit} action={saveLimitPolicy} submitLabel="변경 저장" variant="secondary" confirm="한도 값을 저장합니다. 변경 전/후 값이 감사로그에 기록됩니다.">
                  <input type="hidden" name="id" value={p.id} />
                  <input type="hidden" name="active" value={p.active ? 'on' : ''} />
                  <input type="hidden" name="effectiveFrom" value={p.effectiveFrom.toISOString()} />
                  <LimitFields
                    v={{
                      defaultAmount: p.defaultAmount.toString(),
                      minAmount: p.minAmount.toString(),
                      maxAmount: p.maxAmount.toString(),
                      payerDailyLimit: p.payerDailyLimit.toString(),
                      payerMonthlyLimit: p.payerMonthlyLimit.toString(),
                      perMerchantDailyLimit: p.perMerchantDailyLimit.toString(),
                      payerDailyMaxCount: String(p.payerDailyMaxCount),
                      velocityWindowSec: String(p.velocityWindowSec),
                      velocityMaxCount: String(p.velocityMaxCount),
                      cooldownAfterCount: String(p.cooldownAfterCount),
                      cooldownSec: String(p.cooldownSec),
                      failureLockThreshold: String(p.failureLockThreshold),
                      newPayerFirstDayLimit: p.newPayerFirstDayLimit.toString(),
                      manualReviewAmount: p.manualReviewAmount.toString(),
                    }}
                  />
                </ActionForm>
              </Card>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
