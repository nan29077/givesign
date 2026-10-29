import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, EmptyState, Notice, SectionTitle, StatTile, Table, Td, Th } from '@/components/ui';
import { AdminField, AdminInput, AdminSelect, MerchantOptions } from '@/components/admin/controls';
import { ActionButton, ActionForm } from '@/components/admin/action-form';
import { createFeePolicy, deactivateFeePolicy } from '@/app/actions/admin/settlement';
import { canManageMoney } from '@/components/admin/constants';
import { prisma } from '@/server/db';
import { requireAdmin } from '@/server/auth';
import { formatWon, formatNumber, ratePercent } from '@/lib/money';
import { computeFees } from '@/server/services/settlement';
import { formatKst, kstDateKey } from '@/lib/datetime';

export const dynamic = 'force-dynamic';

export default async function AdminFeesPage({
  searchParams,
}: {
  // 사회복지기관 상세화면에서 "이 사회복지기관 수수료 변경" 으로 들어오면 해당 사회복지기관이 선택된 채로 열린다.
  searchParams: Promise<{ merchantId?: string }>;
}) {
  // 레이아웃 가드에만 기대지 않는다. App Router 는 layout 과 page 를 함께 렌더하므로
  // 비관리자 요청에서도 이 페이지의 조회가 실행될 수 있다(스튜디오·마이페이지와 같은 규약).
  const me = await requireAdmin();
  // 서버 액션과 같은 기준으로 화면의 변경 컨트롤을 잠근다(눌러야 알게 되는 죽은 버튼 방지).
  const canEdit = canManageMoney(me.adminPermission);

  const sp = await searchParams;
  const [policies, merchants] = await Promise.all([
    prisma.feePolicy.findMany({
      orderBy: [{ active: 'desc' }, { effectiveFrom: 'desc' }],
      take: 100,
      select: {
        id: true, scope: true, merchantId: true, pgFeeRate: true, pgFixedFee: true,
        platformFeeRate: true, smsCost: true, vatIncluded: true, settlementDays: true, active: true,
        effectiveFrom: true, effectiveTo: true, createdAt: true,
        merchant: { select: { id: true, displayName: true, code: true } },
      },
    }),
    prisma.merchantProfile.findMany({
      where: { status: 'APPROVED' },
      orderBy: { displayName: 'asc' },
      select: { id: true, displayName: true, code: true },
    }),
  ]);

  // 적용 여부는 active 플래그가 아니라 시행 기간으로 판단한다.
  // active 는 "관리자가 수동으로 마감했는가" 만 뜻한다. 시행일을 미래로 잡은 정책은
  // active 이면서도 아직 적용되지 않으므로, 이 화면의 "현재 적용" 표시도
  // resolveFeePolicy 와 같은 기준을 써야 실제 정산과 어긋나지 않는다.
  const now = new Date();
  const isEffective = (p: { active: boolean; effectiveFrom: Date; effectiveTo: Date | null }) =>
    p.active && p.effectiveFrom <= now && (p.effectiveTo === null || p.effectiveTo > now);
  const isScheduled = (p: { active: boolean; effectiveFrom: Date }) => p.active && p.effectiveFrom > now;

  const activeGlobal = policies.find((p) => isEffective(p) && p.scope === 'GLOBAL');
  const activeMerchantCount = policies.filter((p) => isEffective(p) && p.scope === 'MERCHANT').length;
  const scheduledCount = policies.filter(isScheduled).length;
  // 없는 사회복지기관 ID 가 들어오면 무시한다(선택 안 됨).
  const presetMerchant = merchants.some((m) => m.id === sp.merchantId) ? sp.merchantId : undefined;

  // 실제 정산과 같은 함수로 계산한 예시. 요율만 보고는 부가세 반영 결과를 알기 어렵다.
  const SAMPLE = 3_000n;
  const sample = computeFees(SAMPLE, {
    pgFeeRate: activeGlobal ? activeGlobal.pgFeeRate.toString() : '0.018',
    pgFixedFee: activeGlobal?.pgFixedFee ?? 0n,
    platformFeeRate: activeGlobal ? activeGlobal.platformFeeRate.toString() : '0.15',
    vatIncluded: activeGlobal ? activeGlobal.vatIncluded : true,
  });

  return (
    <>
      <PageHeader
        title="수수료 정책"
        description="정책은 수정하지 않고 새 버전을 추가하는 방식으로 관리합니다. 기존 정책은 마감 처리되어 이력이 보존됩니다."
      />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile
          label="전역 결제 수수료"
          value={activeGlobal ? ratePercent(activeGlobal.pgFeeRate.toString()) : '미설정'}
          sub={activeGlobal ? `고정비 ${formatWon(activeGlobal.pgFixedFee)}` : '기본값 1.80% 적용'}
          tone="brand"
        />
        <StatTile
          label="전역 플랫폼 수수료"
          value={activeGlobal ? ratePercent(activeGlobal.platformFeeRate.toString()) : '미설정'}
          sub={activeGlobal ? `문자 원가 ${formatWon(activeGlobal.smsCost)}` : '기본값 15.00% 적용'}
        />
        <StatTile label="사회복지기관 개별 정책" value={formatNumber(activeMerchantCount)} />
        <StatTile
          label="전체 정책 이력"
          value={formatNumber(policies.length)}
          sub={scheduledCount > 0 ? `최근 100건 · 시행 예정 ${formatNumber(scheduledCount)}건` : '최근 100건'}
        />
      </div>

      {!activeGlobal ? (
        <div className="mt-4">
          <Notice tone="warning" title="적용 중인 전역 수수료 정책이 없습니다">
            개별 정책이 없는 모든 사회복지기관에 <strong className="font-bold">코드 기본값(결제 1.80% / 플랫폼 15.00% ·
            부가세 포함)</strong> 이 그대로 적용됩니다. 아래에서 전역 정책을 등록해 주세요.
            {scheduledCount > 0
              ? ' 시행 예정 정책이 있으나 아직 시행일이 되지 않았습니다.'
              : ''}
          </Notice>
        </div>
      ) : null}

      <Card className="mt-4">
        <CardTitle>{formatWon(SAMPLE)} 결제 기준 계산 예시</CardTitle>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-400">
          현재 적용 중인 전역 정책({sample.vatIncluded ? '부가세 포함 요율' : '부가세 별도 요율'})을 실제 정산 계산식에
          그대로 넣은 결과입니다. 어느 방식이든 공급가액과 부가세는 분리해 원장에 기록됩니다.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-5">
          <StatTile label="결제 총액" value={formatWon(sample.gross)} />
          <StatTile
            label="결제 수수료"
            value={formatWon(sample.pgFee)}
            sub={`공급가 ${formatWon(sample.pgFeeSupply)} + 부가세 ${formatWon(sample.pgFeeVat)}`}
          />
          <StatTile
            label="플랫폼 수수료"
            value={formatWon(sample.platformFee)}
            sub={`공급가 ${formatWon(sample.platformFeeSupply)} + 부가세 ${formatWon(sample.platformFeeVat)}`}
          />
          <StatTile label="부가세 합계" value={formatWon(sample.vat)} />
          <StatTile label="사회복지기관 정산금" value={formatWon(sample.net)} tone="brand" />
        </div>
      </Card>

      <div className="mt-4">
      <Notice tone="warning" title="정책 변경은 과거 거래에 소급되지 않습니다">
        수수료는 결제 승인 시점의 활성 정책으로 계산되어 정산 원장에 확정 기록됩니다. 새 정책을 등록해도 이미 쌓인
        원장 분개는 변경되지 않으며, 정정이 필요하면 조정(ADJUSTMENT) 분개를 사용해야 합니다.
      </Notice>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardTitle>새 정책 등록</CardTitle>
          <p className="mt-1 mb-3 text-[12px] leading-relaxed text-ink-400">
            같은 적용 범위의 기존 활성 정책은 자동으로 마감 처리됩니다.
          </p>
          <ActionForm disabled={!canEdit} action={createFeePolicy} submitLabel="정책 등록" confirm="새 수수료 정책을 등록하고 기존 정책을 마감합니다.">
            <AdminField label="적용 범위">
              <AdminSelect name="scope" defaultValue={presetMerchant ? 'MERCHANT' : 'GLOBAL'}>
                <option value="GLOBAL">전역 (모든 사회복지기관)</option>
                <option value="MERCHANT">사회복지기관 개별</option>
              </AdminSelect>
            </AdminField>
            <AdminField label="사회복지기관" hint="적용 범위가 사회복지기관일 때만 사용됩니다. 개별 정책이 전역 정책보다 우선합니다.">
              <AdminSelect name="merchantId" defaultValue={presetMerchant ?? ''}>
                <MerchantOptions merchants={merchants} allLabel="선택 안 함" />
              </AdminSelect>
            </AdminField>
            <div className="grid grid-cols-2 gap-2">
              <AdminField label="결제 수수료율 (%)" hint="퍼센트로 입력. 예: 1.8 = 1.8%">
                <AdminInput name="pgFeeRate" inputMode="decimal" defaultValue="1.8" required />
              </AdminField>
              <AdminField label="건당 고정비 (원)">
                <AdminInput name="pgFixedFee" inputMode="numeric" defaultValue="0" required />
              </AdminField>
              <AdminField label="플랫폼 수수료율 (%)" hint="퍼센트로 입력. 예: 5.5 = 5.5%">
                <AdminInput name="platformFeeRate" inputMode="decimal" defaultValue="15" required />
              </AdminField>
              <AdminField label="문자 원가 (원)">
                <AdminInput name="smsCost" inputMode="numeric" defaultValue="0" required />
              </AdminField>
              <AdminField label="지급일 (영업일)" hint="결제일 + N영업일에 자동 지급">
                <AdminInput
                  name="settlementDays"
                  inputMode="numeric"
                  defaultValue={activeGlobal ? String(activeGlobal.settlementDays) : '5'}
                  required
                />
              </AdminField>
            </div>
            <AdminField label="적용 시작일 (KST)">
              <AdminInput type="date" name="effectiveFrom" defaultValue={kstDateKey()} />
            </AdminField>
            <label className="flex items-center gap-2 text-[13px] text-ink-700">
              <input type="checkbox" name="vatIncluded" defaultChecked className="h-4 w-4 rounded border-ink-300" />
              부가세 포함 요율 (권장)
            </label>
            <p className="text-[11.5px] leading-relaxed text-ink-400">
              <strong className="font-bold text-ink-700">체크(부가세 포함)</strong> — 위 요율이 부가세까지 포함한
              최종 차감률입니다. 5.5% 를 넣으면 5.5% 를 차감하고, 그 안에서 공급가액 5% 와 부가세 0.5% 를 나눠
              기록합니다.
              <br />
              <strong className="font-bold text-ink-700">해제(부가세 별도)</strong> — 위 요율은 공급가액 기준이며
              부가세 10% 가 추가로 차감됩니다. 5% 를 넣으면 5.5% 를 차감합니다.
              <br />
              어느 쪽이든 원장에는 공급가액과 부가세가 분리 기록됩니다.
            </p>
          </ActionForm>
        </Card>

        <div className="lg:col-span-2">
          <SectionTitle
            title="정책 이력"
            description="상태는 시행 기간으로 판단합니다. 시행일이 아직 오지 않은 정책은 '시행 예정' 입니다."
          />
          {policies.length === 0 ? (
            <EmptyState title="등록된 수수료 정책이 없습니다" description="정책이 없으면 코드 기본값(1.8% / 15%)이 적용됩니다." />
          ) : (
            <Table className="min-w-[900px]">
              <thead>
                <tr>
                  <Th>적용 범위</Th>
                  <Th className="text-right">결제 수수료</Th>
                  <Th className="text-right">고정비</Th>
                  <Th className="text-right">플랫폼 수수료</Th>
                  <Th className="text-right">문자 원가</Th>
                  <Th>부가세</Th>
                  <Th className="text-right">지급일</Th>
                  <Th>적용 기간</Th>
                  <Th>상태</Th>
                  <Th>처리</Th>
                </tr>
              </thead>
              <tbody>
                {policies.map((p) => (
                  <tr key={p.id}>
                    <Td>
                      {p.scope === 'GLOBAL' ? (
                        <Badge tone="brand">전역</Badge>
                      ) : p.merchant ? (
                        <Link href={`/admin/merchants/${p.merchant.id}`} className="font-semibold text-brand-700">
                          {p.merchant.displayName}
                        </Link>
                      ) : (
                        <span className="text-ink-300">-</span>
                      )}
                    </Td>
                    <Td className="text-right tabular-nums">{ratePercent(p.pgFeeRate.toString())}</Td>
                    <Td className="text-right tabular-nums">{formatWon(p.pgFixedFee)}</Td>
                    <Td className="text-right tabular-nums">{ratePercent(p.platformFeeRate.toString())}</Td>
                    <Td className="text-right tabular-nums">{formatWon(p.smsCost)}</Td>
                    <Td>{p.vatIncluded ? '포함' : '별도'}</Td>
                    <Td className="text-right tabular-nums">D+{p.settlementDays}</Td>
                    <Td className="whitespace-nowrap text-[12px]">
                      {formatKst(p.effectiveFrom, false)}
                      <span className="block text-ink-400">~ {p.effectiveTo ? formatKst(p.effectiveTo, false) : '현재'}</span>
                    </Td>
                    <Td>
                      {isEffective(p) ? (
                        <Badge tone="success">적용 중</Badge>
                      ) : isScheduled(p) ? (
                        <Badge tone="warning">시행 예정</Badge>
                      ) : (
                        <Badge tone="neutral">종료</Badge>
                      )}
                    </Td>
                    <Td>
                      {p.active ? (
                        <ActionButton disabled={!canEdit}
                          action={deactivateFeePolicy}
                          values={{ id: p.id }}
                          label="마감"
                          confirm="이 정책을 마감합니다. 마감 후에는 상위 범위 정책 또는 기본값이 적용됩니다."
                        />
                      ) : (
                        <span className="text-[12px] text-ink-300">-</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      </div>
    </>
  );
}
