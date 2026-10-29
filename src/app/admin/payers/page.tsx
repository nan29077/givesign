import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, EmptyState, Notice, StatTile, Table, Td, Th } from '@/components/ui';
import { AdminField, AdminInput, AdminSelect, FilterBar, Pager } from '@/components/admin/controls';
import { ActionButton, ActionForm } from '@/components/admin/action-form';
import { PAGE_SIZE, parsePage, PAID_CHARGE_STATUSES, clampPage, canWrite, canManageMoney } from '@/components/admin/constants';
import { bankLabel } from '@/components/admin/mask';
import { unlockPayer, setPayerBlock, updatePayerLimitsByAdmin } from '@/app/actions/admin/accounts';
import { prisma } from '@/server/db';
import { requireAdmin } from '@/server/auth';
import { formatWon, formatNumber } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import type { Prisma } from '@/generated/prisma/client';
import { payerOnboardingStatusLabel } from '@/lib/labels';

export const dynamic = 'force-dynamic';

type StateFilter = '' | 'LOCKED' | 'BLOCKED' | 'REGISTERED' | 'UNREGISTERED';

export default async function AdminPayersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; state?: string; page?: string }>;
}) {
  // 레이아웃 가드에만 기대지 않는다. App Router 는 layout 과 page 를 함께 렌더하므로
  // 비관리자 요청에서도 이 페이지의 조회가 실행될 수 있다(스튜디오·마이페이지와 같은 규약).
  const me = await requireAdmin();
  // 서버 액션과 같은 기준으로 화면의 변경 컨트롤을 잠근다(눌러야 알게 되는 죽은 버튼 방지).
  const canEdit = canWrite(me.adminPermission);
  // 한도 변경은 updatePayerLimitsByAdmin 이 SUPPORT 를 막는다. 잠금 해제·이용 제한과 기준이 다르다.
  const canEditLimits = canManageMoney(me.adminPermission);

  const sp = await searchParams;
  const page = parsePage(sp.page);
  const q = (sp.q ?? '').trim();
  const state = (['LOCKED', 'BLOCKED', 'REGISTERED', 'UNREGISTERED'].includes(sp.state ?? '')
    ? sp.state
    : '') as StateFilter;

  const now = new Date();
  const where: Prisma.PayerProfileWhereInput = {
    ...(q ? { phoneMasked: { contains: q } } : {}),
    ...(state === 'LOCKED' ? { lockedUntil: { gt: now } } : {}),
    ...(state === 'BLOCKED' ? { blockedAt: { not: null } } : {}),
    ...(state === 'REGISTERED' ? { registeredAt: { not: null } } : {}),
    ...(state === 'UNREGISTERED' ? { registeredAt: null } : {}),
  };

  const [total, payers, lockedCount, blockedCount, registeredCount] = await Promise.all([
    prisma.payerProfile.count({ where }),
    prisma.payerProfile.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true, phoneMasked: true, displayName: true, createdAt: true, registeredAt: true,
        onboardingStatus: true, registrationLinkSentAt: true,
        failCount: true, lockedUntil: true, blockedAt: true, blockedReason: true,
        dailyLimit: true, monthlyLimit: true,
        paymentTokens: {
          where: { status: 'ACTIVE' },
          select: { bankName: true, accountTail4: true, registeredAt: true },
          take: 1,
          orderBy: { registeredAt: 'desc' },
        },
      },
    }),
    prisma.payerProfile.count({ where: { lockedUntil: { gt: now } } }),
    prisma.payerProfile.count({ where: { blockedAt: { not: null } } }),
    prisma.payerProfile.count({ where: { registeredAt: { not: null } } }),
  ]);

  const payerIds = payers.map((d) => d.id);
  const totals = payerIds.length
    ? await prisma.charge.groupBy({
        by: ['payerId'],
        where: { payerId: { in: payerIds }, status: { in: PAID_CHARGE_STATUSES } },
        _sum: { amount: true },
        _count: { _all: true },
      })
    : [];
  const totalMap = new Map(totals.map((t) => [t.payerId ?? '', t]));

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // 범위를 벗어난 ?page= 는 마지막 페이지로 보낸다(빈 화면에서 돌아갈 링크가 없어진다).
  clampPage({ basePath: '/admin/payers', params: { q, state }, page, lastPage, total });

  return (
    <>
      <PageHeader
        title="후원자 관리"
        description="문자만으로 생성된 후원자를 포함합니다. 전화번호는 마스킹, 계좌는 은행명과 끝 4자리만 표시합니다."
      />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile label="전체 후원자" value={formatNumber(total)} sub="현재 조건 기준" />
        <StatTile label="계좌 등록 완료" value={formatNumber(registeredCount)} tone="success" />
        <StatTile label="결제 실패 잠금" value={formatNumber(lockedCount)} tone={lockedCount > 0 ? 'warning' : 'neutral'} />
        <StatTile label="이용 제한" value={formatNumber(blockedCount)} tone={blockedCount > 0 ? 'danger' : 'neutral'} />
      </div>

      <FilterBar action="/admin/payers" resetHref="/admin/payers">
        <AdminField label="연락처 검색 (마스킹 기준)" className="w-56">
          <AdminInput name="q" defaultValue={q} placeholder="010-****-1234" />
        </AdminField>
        <AdminField label="상태" className="w-44">
          <AdminSelect name="state" defaultValue={state}>
            <option value="">전체</option>
            <option value="REGISTERED">계좌 등록 완료</option>
            <option value="UNREGISTERED">계좌 미등록</option>
            <option value="LOCKED">결제 실패 잠금</option>
            <option value="BLOCKED">이용 제한</option>
          </AdminSelect>
        </AdminField>
      </FilterBar>

      <Notice tone="neutral" title="잠금과 이용 제한은 다릅니다">
        결제 실패 잠금은 연속 실패로 자동 설정되며 관리자 해제 전까지 결제가 접수되지 않습니다. 이용 제한은 운영 판단에
        따른 수동 차단입니다.
      </Notice>

      <div className="mt-4">
        {payers.length === 0 ? (
          <EmptyState title="조건에 맞는 후원자가 없습니다" />
        ) : (
          <>
            <Table className="min-w-[1100px]">
              <thead>
                <tr>
                  <Th>연락처</Th>
                  <Th>등록일</Th>
                  <Th>계좌 등록</Th>
                  <Th className="text-right">누적 결제</Th>
                  <Th className="text-right">실패</Th>
                  <Th>잠금·제한</Th>
                  <Th>개인 한도</Th>
                  <Th>처리</Th>
                </tr>
              </thead>
              <tbody>
                {payers.map((d) => {
                  const agg = totalMap.get(d.id);
                  const token = d.paymentTokens[0];
                  const locked = d.lockedUntil != null && d.lockedUntil > now;
                  return (
                    <tr key={d.id}>
                      <Td>
                        <Link href={`/admin/payers/${d.id}`} className="font-semibold text-brand-700">
                          {d.phoneMasked}
                        </Link>
                        {d.displayName ? (
                          <span className="mt-0.5 block text-[11px] text-ink-400">{d.displayName}</span>
                        ) : null}
                      </Td>
                      <Td className="whitespace-nowrap">{formatKst(d.createdAt, false)}</Td>
                      <Td>
                        {token ? (
                          <>
                            <Badge tone={payerOnboardingStatusLabel[d.onboardingStatus].tone}>
                              {payerOnboardingStatusLabel[d.onboardingStatus].text}
                            </Badge>
                            <span className="mt-0.5 block text-[11px] text-ink-500">
                              {bankLabel(token.bankName, token.accountTail4)}
                            </span>
                          </>
                        ) : (
                          <>
                            <Badge tone={payerOnboardingStatusLabel[d.onboardingStatus].tone}>
                              {payerOnboardingStatusLabel[d.onboardingStatus].text}
                            </Badge>
                            {d.registrationLinkSentAt ? (
                              <span className="mt-0.5 block text-[11px] text-ink-400">
                                {formatKst(d.registrationLinkSentAt, false)}
                              </span>
                            ) : null}
                          </>
                        )}
                      </Td>
                      <Td className="text-right tabular-nums">
                        {formatWon(agg?._sum.amount ?? 0n)}
                        <span className="mt-0.5 block text-[11px] text-ink-400">{formatNumber(agg?._count._all ?? 0)}건</span>
                      </Td>
                      <Td className="text-right tabular-nums">{formatNumber(d.failCount)}</Td>
                      <Td>
                        {locked ? <Badge tone="warning">잠금 {formatKst(d.lockedUntil, false)}</Badge> : null}
                        {d.blockedAt ? (
                          <>
                            <Badge tone="danger">이용 제한</Badge>
                            <span className="mt-0.5 block max-w-[160px] text-[11px] break-words text-ink-400">
                              {d.blockedReason ?? '-'}
                            </span>
                          </>
                        ) : null}
                        {!locked && !d.blockedAt ? <Badge tone="success">정상</Badge> : null}
                      </Td>
                      <Td className="text-[12px]">
                        <details>
                          <summary className="cursor-pointer text-brand-700">
                            {d.dailyLimit != null || d.monthlyLimit != null ? '개별 설정됨' : '정책 기본값'}
                          </summary>
                          <div className="mt-2 w-52">
                            <ActionForm disabled={!canEditLimits} action={updatePayerLimitsByAdmin} submitLabel="한도 저장" variant="secondary" compact>
                              <input type="hidden" name="payerId" value={d.id} />
                              <AdminField label="일 한도 (비우면 정책값)">
                                <AdminInput
                                  name="dailyLimit"
                                  inputMode="numeric"
                                  defaultValue={d.dailyLimit != null ? d.dailyLimit.toString() : ''}
                                />
                              </AdminField>
                              <AdminField label="월 한도 (비우면 정책값)">
                                <AdminInput
                                  name="monthlyLimit"
                                  inputMode="numeric"
                                  defaultValue={d.monthlyLimit != null ? d.monthlyLimit.toString() : ''}
                                />
                              </AdminField>
                            </ActionForm>
                          </div>
                        </details>
                      </Td>
                      <Td>
                        <div className="flex flex-col gap-1.5">
                          <ActionButton
                            action={unlockPayer}
                            values={{ payerId: d.id }}
                            label="잠금 해제"
                            disabled={!canEdit || (!locked && d.failCount === 0)}
                            confirm="결제 실패 잠금을 해제하고 실패 횟수를 0으로 되돌립니다."
                          />
                          {d.blockedAt ? (
                            <ActionButton disabled={!canEdit}
                              action={setPayerBlock}
                              values={{ payerId: d.id, next: 'UNBLOCK' }}
                              label="제한 해제"
                              confirm="이 후원자의 이용 제한을 해제합니다."
                            />
                          ) : (
                            <details>
                              <summary className="cursor-pointer text-[12px] text-danger-500">이용 제한</summary>
                              <div className="mt-1.5 w-48">
                                <ActionForm disabled={!canEdit}
                                  action={setPayerBlock}
                                  submitLabel="제한 적용"
                                  variant="danger"
                                  compact
                                  confirm="이 후원자의 이용을 제한합니다. 이후 문자후원가 접수되지 않습니다."
                                >
                                  <input type="hidden" name="payerId" value={d.id} />
                                  <input type="hidden" name="next" value="BLOCK" />
                                  <AdminField label="제한 사유">
                                    <AdminInput name="reason" placeholder="예: 반복 분쟁 신고" />
                                  </AdminField>
                                </ActionForm>
                              </div>
                            </details>
                          )}
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
            <Pager
              basePath="/admin/payers"
              params={{ q, state }}
              page={page}
              lastPage={lastPage}
              total={total}
            />
          </>
        )}
      </div>
    </>
  );
}
