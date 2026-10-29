import { maskBusinessNo } from '@/components/admin/mask';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import {
  Badge, Card, CardTitle, DataRow, EmptyState, Notice, SectionTitle, StatTile, Table, Td, Th,
} from '@/components/ui';
import { ActionButton, ActionForm, SelectActionForm } from '@/components/admin/action-form';
import { updateMerchantStatus, updateMerchantPaymentMode, reissueMerchantCode, updateMerchantAmountBounds, setSettlementAccountVerified } from '@/app/actions/admin/accounts';
import { prisma } from '@/server/db';
import { canManageMoney } from '@/components/admin/constants';
import { requireAdmin } from '@/server/auth';
import { getSettlementSummary } from '@/server/services/settlement';
import { resolveFeePolicy } from '@/server/services/settlement';
import { env } from '@/lib/env';
import { formatWon, formatNumber, ratePercent } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import { merchantStatusLabel, chargeStatusLabel, paymentModeLabel, moNumberStatusLabel } from '@/lib/labels';
import { AdminField, AdminInput } from '@/components/admin/controls';

export const dynamic = 'force-dynamic';

export default async function AdminMerchantDetailPage({ params }: { params: Promise<{ id: string }> }) {
  // 레이아웃 가드에만 기대지 않는다. App Router 는 layout 과 page 를 함께 렌더하므로
  // 비관리자 요청에서도 이 페이지의 조회가 실행될 수 있다(스튜디오·마이페이지와 같은 규약).
  const me = await requireAdmin();
  // 서버 액션과 같은 기준으로 화면의 변경 컨트롤을 잠근다.
  const canEdit = canManageMoney(me.adminPermission);

  const { id } = await params;

  const merchant = await prisma.merchantProfile.findUnique({
    where: { id },
    select: {
      id: true, displayName: true, channelName: true, description: true, code: true, status: true,
      allowCustomAmount: true, minAmount: true, maxAmount: true, paymentMode: true, businessNo: true,
      approvedAt: true, suspendedAt: true, createdAt: true,
      user: { select: { email: true, name: true, phoneMasked: true, status: true } },
      codes: { orderBy: { issuedAt: 'desc' }, take: 10, select: { id: true, code: true, active: true, issuedAt: true, revokedAt: true } },
      moRoutes: {
        orderBy: { assignedAt: 'desc' },
        select: { id: true, phoneNumber: true, keyword: true, mode: true, status: true, monthlyCost: true, assignedAt: true },
      },
      settlementAccount: { select: { bankName: true, accountTail4: true, holderMasked: true, verified: true, verifiedAt: true } },
      chargeProducts: {
        where: { archivedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { amount: 'asc' }],
        select: { id: true, name: true, amount: true, active: true },
      },
    },
  });
  if (!merchant) notFound();

  const [summary, feePolicy, charges, chargeAgg] = await Promise.all([
    getSettlementSummary(id),
    resolveFeePolicy(id),
    prisma.charge.findMany({
      where: { merchantId: id },
      orderBy: { receivedAt: 'desc' },
      take: 20,
      select: {
        id: true, transactionNo: true, amount: true, status: true, receivedAt: true, paidAt: true,
        payer: { select: { phoneMasked: true } },
      },
    }),
    prisma.charge.aggregate({ where: { merchantId: id }, _count: { _all: true }, _sum: { amount: true } }),
  ]);

  const directBlocked = !env.safety.allowDirectTrigger;

  return (
    <>
      <PageHeader
        title={merchant.displayName}
        description={`코드 ${merchant.code} · ${merchant.channelName ?? '채널명 미등록'}`}
        action={
          <Link href="/admin/merchants" className="rounded-lg border border-ink-200 px-3 py-1.5 text-[12px] font-semibold text-ink-700">
            목록으로
          </Link>
        }
      />

      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <StatTile label="정산 잔액" value={formatWon(summary.balance)} tone="brand" />
          <StatTile label="정산 요청 보류" value={formatWon(summary.pending)} tone={summary.pending > 0n ? 'warning' : 'neutral'} />
          <StatTile label="정산 가능" value={formatWon(summary.available)} tone="success" />
          <StatTile
            label="누적 결제"
            value={formatWon(chargeAgg._sum.amount ?? 0n)}
            sub={`${formatNumber(chargeAgg._count._all)}건 (전 상태 포함)`}
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardTitle>프로필</CardTitle>
            <div className="mt-2">
              <DataRow
                label="심사 상태"
                value={<Badge tone={merchantStatusLabel[merchant.status].tone}>{merchantStatusLabel[merchant.status].text}</Badge>}
              />
              <DataRow label="담당자" value={`${merchant.user.name ?? '-'} / ${merchant.user.email ?? '-'}`} />
              <DataRow label="연락처" value={merchant.user.phoneMasked ?? '-'} />
              <DataRow label="사업자번호" value={maskBusinessNo(merchant.businessNo)} />
              <DataRow
                label="후원 항목"
                value={
                  merchant.chargeProducts.length === 0
                    ? '등록 없음'
                    : merchant.chargeProducts
                        .map((p) => `${p.name} ${formatWon(p.amount)}${p.active ? '' : ' (사용 안 함)'}`)
                        .join(' · ')
                }
              />
              <DataRow label="직접 입력" value={merchant.allowCustomAmount ? '허용' : '허용 안 함'} />
              <DataRow label="허용 범위" value={`${formatWon(merchant.minAmount)} ~ ${formatWon(merchant.maxAmount)}`} />
              <DataRow label="신청일" value={formatKst(merchant.createdAt)} />
              <DataRow label="승인일" value={formatKst(merchant.approvedAt)} />
              <DataRow label="정지일" value={formatKst(merchant.suspendedAt)} />
            </div>
            <div className="mt-3 rounded-xl border border-ink-100 px-3 py-3">
              <p className="mb-2 text-[12.5px] font-bold text-ink-900">1건 결제 금액 허용 범위 변경</p>
              <ActionForm disabled={!canEdit}
                action={updateMerchantAmountBounds}
                submitLabel="범위 저장"
                confirm="이 사회복지기관의 1건 결제 금액 허용 범위를 변경합니다. 범위를 벗어난 후원 항목은 판매 중지(비활성)됩니다. 상품 금액은 바꾸지 않습니다."
              >
                <input type="hidden" name="merchantId" value={merchant.id} />
                <div className="grid grid-cols-2 gap-2">
                  <AdminField label="1건 최소 (원)">
                    <AdminInput name="minAmount" inputMode="numeric" defaultValue={merchant.minAmount.toString()} required />
                  </AdminField>
                  <AdminField label="1건 최대 (원)">
                    <AdminInput name="maxAmount" inputMode="numeric" defaultValue={merchant.maxAmount.toString()} required />
                  </AdminField>
                </div>
              </ActionForm>
            </div>
            <div className="mt-3">
              <SelectActionForm disabled={!canEdit}
                action={updateMerchantStatus}
                values={{ merchantId: merchant.id }}
                name="status"
                defaultValue={merchant.status}
                options={[
                  { value: 'PENDING', label: '심사대기' },
                  { value: 'APPROVED', label: '승인' },
                  { value: 'REJECTED', label: '반려' },
                  { value: 'SUSPENDED', label: '정지' },
                ]}
                submitLabel="심사 상태 변경"
                confirm="심사 상태를 변경합니다."
              />
            </div>
          </Card>

          <Card>
            <CardTitle>결제 모드</CardTitle>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-500">
              현재 설정: {merchant.paymentMode ? paymentModeLabel[merchant.paymentMode] : '전역 설정 사용'}
            </p>
            <div className="mt-3">
              <SelectActionForm disabled={!canEdit}
                action={updateMerchantPaymentMode}
                values={{ merchantId: merchant.id }}
                name="paymentMode"
                defaultValue={merchant.paymentMode ?? ''}
                options={[
                  { value: '', label: '전역 설정 사용' },
                  { value: 'CONFIRM_LINK', label: paymentModeLabel.CONFIRM_LINK },
                  {
                    value: 'DIRECT_TRIGGER',
                    label: `${paymentModeLabel.DIRECT_TRIGGER}${directBlocked ? ' — 사용 불가' : ''}`,
                    disabled: directBlocked,
                  },
                ]}
                submitLabel="결제 모드 변경"
                confirm="결제 모드를 변경합니다. 변경 내역은 감사로그에 기록됩니다."
              />
            </div>
            {directBlocked ? (
              <div className="mt-3">
                <Notice tone="danger" title="즉시형 결제 선택 불가">
                  금융사 서면승인이 등록되지 않아 즉시형 결제를 활성화할 수 없습니다. 서면승인 등록 후
                  ALLOW_DIRECT_TRIGGER 를 켜야 선택할 수 있습니다.
                </Notice>
              </div>
            ) : null}

            <div className="mt-4">
              <div className="flex items-center justify-between gap-2">
                <CardTitle>수수료 정책</CardTitle>
                <Link
                  href={`/admin/fees?merchantId=${merchant.id}`}
                  className="text-[12.5px] font-bold text-brand-700 hover:underline"
                >
                  이 사회복지기관 수수료 변경
                </Link>
              </div>
              <div className="mt-2">
                <DataRow
                  label="적용 범위"
                  value={
                    feePolicy
                      ? feePolicy.scope === 'MERCHANT'
                        ? '이 사회복지기관 개별 정책'
                        : '전역 정책'
                      : '코드 기본값 (정책 미등록)'
                  }
                />
                <DataRow
                  label="결제 수수료"
                  value={`${ratePercent(feePolicy ? feePolicy.pgFeeRate.toString() : '0.018')}${
                    feePolicy && feePolicy.pgFixedFee > 0n ? ` + ${formatWon(feePolicy.pgFixedFee)}` : ''
                  }`}
                />
                <DataRow
                  label="플랫폼 수수료"
                  value={ratePercent(feePolicy ? feePolicy.platformFeeRate.toString() : '0.15')}
                />
                <DataRow
                  label="부가세"
                  value={
                    (feePolicy ? feePolicy.vatIncluded : true)
                      ? '요율에 포함 (요율 안에서 공급가액·부가세 분리 기록)'
                      : '별도 (공급가액의 10% 추가 차감)'
                  }
                />
                <DataRow label="문자 원가" value={feePolicy ? formatWon(feePolicy.smsCost) : '-'} />
              </div>
            </div>
          </Card>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <div className="flex items-center justify-between gap-2">
              <CardTitle>사회복지기관 코드</CardTitle>
              <ActionButton disabled={!canEdit}
                action={reissueMerchantCode}
                values={{ merchantId: merchant.id }}
                label="코드 재발급"
                variant="danger"
                confirm="코드를 재발급하면 기존 결제 링크가 즉시 무효화됩니다. 계속할까요?"
              />
            </div>
            <div className="mt-3">
              <Table className="min-w-0">
                <thead>
                  <tr>
                    <Th>코드</Th>
                    <Th>상태</Th>
                    <Th>발급</Th>
                    <Th>폐기</Th>
                  </tr>
                </thead>
                <tbody>
                  {merchant.codes.map((c) => (
                    <tr key={c.id}>
                      <Td className="font-mono text-[12px]">{c.code}</Td>
                      <Td>{c.active ? <Badge tone="success">활성</Badge> : <Badge tone="neutral">폐기</Badge>}</Td>
                      <Td className="whitespace-nowrap">{formatKst(c.issuedAt, false)}</Td>
                      <Td className="whitespace-nowrap">{formatKst(c.revokedAt, false)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </Card>

          <Card>
            <CardTitle>MO 수신 번호</CardTitle>
            <div className="mt-3">
              {merchant.moRoutes.length === 0 ? (
                <EmptyState
                  title="배정된 MO 번호가 없습니다"
                  description="MO 번호 관리 화면에서 수신 번호를 배정해야 문자후원이 접수됩니다."
                />
              ) : (
                <Table className="min-w-0">
                  <thead>
                    <tr>
                      <Th>번호</Th>
                      <Th>키워드</Th>
                      <Th>모드</Th>
                      <Th>상태</Th>
                      <Th className="text-right">월 비용</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {merchant.moRoutes.map((m) => (
                      <tr key={m.id}>
                        <Td className="font-mono text-[12px]">{m.phoneNumber}</Td>
                        <Td>{m.keyword ?? '-'}</Td>
                        <Td>{m.mode === 'DEDICATED' ? '전용번호' : '대표번호 공유'}</Td>
                        <Td>
                          <Badge tone={moNumberStatusLabel[m.status].tone}>{moNumberStatusLabel[m.status].text}</Badge>
                        </Td>
                        <Td className="text-right tabular-nums">{formatWon(m.monthlyCost)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
              <div className="mt-3">
                <Link href="/admin/mo-numbers" className="text-[12px] font-semibold text-brand-700">
                  MO 번호 관리로 이동
                </Link>
              </div>
            </div>
          </Card>
        </div>

        <div className="max-w-2xl">
          <Card>
            <CardTitle>정산 계좌</CardTitle>
            <div className="mt-2">
              {merchant.settlementAccount ? (
                <>
                  <DataRow
                    label="계좌"
                    value={`${merchant.settlementAccount.bankName} ****${merchant.settlementAccount.accountTail4}`}
                  />
                  <DataRow label="예금주" value={merchant.settlementAccount.holderMasked} />
                  <DataRow
                    label="인증"
                    value={
                      merchant.settlementAccount.verified ? (
                        <Badge tone="success">인증 완료</Badge>
                      ) : (
                        <Badge tone="warning">미인증</Badge>
                      )
                    }
                  />
                  <DataRow label="인증일" value={formatKst(merchant.settlementAccount.verifiedAt)} />
                </>
              ) : (
                <p className="text-[13px] text-ink-400">등록된 정산 계좌가 없습니다.</p>
              )}
            </div>

            {merchant.settlementAccount ? (
              <div className="mt-3 border-t border-ink-100 pt-3">
                <p className="mb-2 text-[12px] leading-relaxed text-ink-500">
                  예금주 실명확인 API 연동 전까지는 증빙(통장사본·사업자등록증)을 확인한 뒤 수동으로 처리합니다.
                  인증되지 않은 계좌로는 정산을 요청할 수 없습니다.
                </p>
                {merchant.settlementAccount.verified ? (
                  <ActionButton disabled={!canEdit}
                    action={setSettlementAccountVerified}
                    values={{ merchantId: merchant.id, verified: 'false' }}
                    label="인증 해제"
                    variant="danger"
                    confirm="정산 계좌 인증을 해제합니다. 재확인 전까지 이 사회복지기관은 정산을 요청할 수 없습니다."
                  />
                ) : (
                  <ActionButton disabled={!canEdit}
                    action={setSettlementAccountVerified}
                    values={{ merchantId: merchant.id, verified: 'true' }}
                    label="실명확인 완료 처리"
                    confirm="증빙 확인이 끝났습니까? 인증 완료로 처리하면 이 사회복지기관이 정산을 요청할 수 있습니다."
                  />
                )}
              </div>
            ) : null}
          </Card>

        </div>

        <section>
          <SectionTitle title="정산 요약" description="원장 합계 기준. 원장은 append-only 이며 수정할 수 없습니다." />
          <Card>
            <DataRow label="결제 총액" value={formatWon(summary.totalGross)} />
            <DataRow label="결제 수수료" value={formatWon(-summary.totalPgFee)} />
            <DataRow label="플랫폼 수수료" value={formatWon(-summary.totalPlatformFee)} />
            <DataRow label="환불(수수료 환입 포함)" value={formatWon(-summary.totalRefund)} />
            <DataRow label="조정" value={formatWon(summary.totalAdjustment)} />
            <DataRow label="지급 완료" value={formatWon(-summary.totalPaid)} />
            <DataRow label="현재 잔액" value={<span className="text-brand-700">{formatWon(summary.balance)}</span>} />
          </Card>
        </section>

        <section>
          <SectionTitle title="최근 결제 20건" />
          {charges.length === 0 ? (
            <EmptyState title="후원 내역이 없습니다" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>거래번호</Th>
                  <Th>후원자</Th>
                  <Th className="text-right">금액</Th>
                  <Th>상태</Th>
                  <Th>수신</Th>
                  <Th>결제</Th>
                </tr>
              </thead>
              <tbody>
                {charges.map((d) => (
                  <tr key={d.id}>
                    <Td className="font-mono text-[12px]">{d.transactionNo}</Td>
                    <Td>{d.payer?.phoneMasked ?? '-'}</Td>
                    <Td className="text-right tabular-nums">{formatWon(d.amount)}</Td>
                    <Td>
                      <Badge tone={chargeStatusLabel[d.status].tone}>{chargeStatusLabel[d.status].text}</Badge>
                    </Td>
                    <Td className="whitespace-nowrap">{formatKst(d.receivedAt, false)}</Td>
                    <Td className="whitespace-nowrap">{formatKst(d.paidAt, false)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>
      </div>
    </>
  );
}
