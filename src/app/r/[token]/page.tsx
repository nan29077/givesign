import type { Metadata } from 'next';
import {
  AlertTriangle,
  Ban,
  CircleX,
  Clock,
  Hourglass,
  MessageSquare,
  Phone,
  Wallet,
} from 'lucide-react';
import { Card, CardTitle, DataRow, Notice } from '@/components/ui';
import { prisma } from '@/server/db';
import { resolveSecureLink } from '@/server/services/secure-link';
import { loadRegistrationContext } from '@/server/services/payer-registration';
import { loadConfirmContext } from '@/server/services/charge-confirm';
import { resolvePolicy } from '@/server/services/limits';
import { formatWon } from '@/lib/money';
import { computeFees } from '@/server/services/settlement';
import { LinkShell } from './link-shell';
import { RegisterForm, type TermsItem } from './register-form';
import { defaultPayerName } from '@/lib/payer-name';
import { ConfirmPanel } from './confirm-panel';
import { SelectAmountPanel } from './select-amount-panel';
import { loadSelectAmountContext } from '@/server/services/charge-select';
import { currentTermsList } from '@/server/services/terms';
import { getPaymentAdapter } from '@/server/adapters/payment';

/**
 * MT 문자로 발송된 1회용 보안링크 진입점.
 *  - REGISTER_ACCOUNT : 최초 계좌 등록 + 이용 동의
 *  - SELECT_AMOUNT    : 후원 금액 선택 → 결제사 PIN 인증
 *  - CONFIRM_PAYMENT  : (구) 문자후원 결제 확인
 * 검색엔진 색인을 막고, 항상 서버에서 새로 검증한다.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '기브싸인 결제 확인',
  robots: { index: false, follow: false },
};

export default async function SecureLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const res = await resolveSecureLink(token);

  if (!res.ok) {
    return (
      <LinkShell>
        <InvalidLink reason={res.reason} />
      </LinkShell>
    );
  }

  const purpose = res.link!.purpose;

  if (purpose === 'REGISTER_ACCOUNT') {
    return (
      <LinkShell>
        <RegisterScreen token={token} />
      </LinkShell>
    );
  }

  if (purpose === 'SELECT_AMOUNT') {
    return (
      <LinkShell>
        <SelectAmountScreen token={token} />
      </LinkShell>
    );
  }

  if (purpose === 'CONFIRM_PAYMENT') {
    return (
      <LinkShell>
        <ConfirmScreen token={token} />
      </LinkShell>
    );
  }

  return (
    <LinkShell>
      <Card>
        <CardTitle>지원하지 않는 링크입니다</CardTitle>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-500">
          이 링크의 용도는 현재 화면에서 처리할 수 없습니다. 고객센터로 문의해 주세요.
        </p>
      </Card>
    </LinkShell>
  );
}

// --------------------------------------------------------------- 링크 오류 화면

function InvalidLink({ reason }: { reason: 'NOT_FOUND' | 'EXPIRED' | 'USED' }) {
  if (reason === 'EXPIRED') {
    return (
      <Card>
        <div className="flex items-center gap-2 text-warning-500">
          <Hourglass size={20} strokeWidth={1.7} />
          <p className="text-[16px] font-extrabold text-ink-900">확인 시간이 지났습니다</p>
        </div>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-700">
          확인 시간이 지나 결제가 자동 취소되었습니다. 결제는 진행되지 않았습니다.
        </p>
        <div className="mt-3">
          <Notice tone="neutral">
            다시 결제하시려면 사회복지기관 번호로 문자를 새로 보내주세요. 새 확인 링크가 발송됩니다.
          </Notice>
        </div>
      </Card>
    );
  }

  if (reason === 'USED') {
    return (
      <Card>
        <div className="flex items-center gap-2 text-ink-500">
          <Clock size={20} strokeWidth={1.7} />
          <p className="text-[16px] font-extrabold text-ink-900">이미 처리된 링크입니다</p>
        </div>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-700">
          이 링크는 1회만 사용할 수 있으며 이미 사용되었습니다. 처리 결과는 문자로 안내되었습니다.
        </p>
        <div className="mt-3">
          <Notice tone="neutral">
            같은 링크를 다시 열어도 중복 결제는 발생하지 않습니다. 결과가 확인되지 않으면 고객센터로 문의해 주세요.
          </Notice>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-center gap-2 text-danger-500">
        <CircleX size={20} strokeWidth={1.7} />
        <p className="text-[16px] font-extrabold text-ink-900">유효하지 않은 링크입니다</p>
      </div>
      <p className="mt-2 text-[13.5px] leading-relaxed text-ink-700">
        주소가 잘못되었거나 더 이상 사용할 수 없는 링크입니다. 결제는 진행되지 않았습니다.
      </p>
      <div className="mt-3">
        <Notice tone="warning" title="주의">
          기브싸인은 문자로 발송한 링크 외에 다른 경로로 계좌 정보를 요구하지 않습니다.
        </Notice>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------- 계좌 등록 화면

async function RegisterScreen({ token }: { token: string }) {
  const loaded = await loadRegistrationContext(token);
  if (!loaded.ok) {
    return (
      <Card>
        <CardTitle>등록을 진행할 수 없습니다</CardTitle>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-700">{loaded.reason}</p>
      </Card>
    );
  }
  const ctx = loaded.ctx;

  // 시행일이 도래한 정책·약관만 노출한다.
  const nowForPolicy = new Date();
  const [moNumber, feePolicy, policy, termsRows] = await Promise.all([
    ctx.merchantId
      ? prisma.merchantMoNumber.findFirst({ where: { merchantId: ctx.merchantId, status: 'ASSIGNED' } })
      : Promise.resolve(null),
    prisma.feePolicy.findFirst({
      where: {
        scope: 'GLOBAL',
        active: true,
        effectiveFrom: { lte: nowForPolicy },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: nowForPolicy } }],
      },
      orderBy: { effectiveFrom: 'desc' },
    }),
    resolvePolicy(ctx.merchantId, ctx.payerId, nowForPolicy),
    // 유형별 현재 시행본만 가져온다(시행 예정 개정안은 제외).
    currentTermsList(nowForPolicy),
  ]);

  // 등록 시점에는 후원 금액이 정해지지 않았다(문자를 보낸 뒤 링크에서 고른다).
  // 수수료 구조를 보여 주기 위해 가장 낮은 후원 항목 금액을 예시로 쓴다.
  const sampleProduct = ctx.merchantId
    ? await prisma.chargeProduct.findFirst({
        where: { merchantId: ctx.merchantId, active: true, archivedAt: null },
        orderBy: { amount: 'asc' },
        select: { amount: true },
      })
    : null;
  const amount = sampleProduct?.amount ?? policy.minAmount;
  // 실제 정산과 같은 계산식을 쓴다. 화면에서 따로 계산하면 부가세 처리가 어긋난다.
  const fees = computeFees(amount, {
    pgFeeRate: feePolicy ? feePolicy.pgFeeRate.toString() : '0.018',
    pgFixedFee: feePolicy?.pgFixedFee ?? 0n,
    platformFeeRate: feePolicy ? feePolicy.platformFeeRate.toString() : '0.15',
    vatIncluded: feePolicy ? feePolicy.vatIncluded : true,
  });
  const pgFixed = feePolicy?.pgFixedFee ?? 0n;
  const pct = (rate: string) => `${(Number(rate) * 100).toFixed(1)}%`;

  // currentTermsList 가 유형별 1건만 돌려준다. 필수 항목을 위로 올려 보여 준다.
  const terms: TermsItem[] = [];
  for (const t of [...termsRows].sort((a, b) => Number(b.required) - Number(a.required))) {
    terms.push({
      id: t.id,
      type: t.type,
      title: t.title,
      content: t.content,
      required: t.required,
      version: t.version,
    });
  }

  return (
    <div className="space-y-3">
      <Card>
        <p className="text-[12px] font-semibold text-brand-700">최초 1회 계좌 등록</p>
        <h1 className="mt-1 text-[20px] font-extrabold leading-snug tracking-tight text-ink-900">
          {ctx.merchantName ?? '사회복지기관'} 결제를 위한
          <br />
          계좌 등록과 이용 동의
        </h1>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-500">
          보내주신 문자로는 아직 후원되지 않았습니다. 아래 내용을 확인하고 등록을 완료해 주세요.
        </p>
        <div className="mt-3">
          <DataRow label="결제 대상" value={ctx.merchantName ?? '-'} />
          <DataRow
            label="결제 수신번호"
            value={
              moNumber ? (
                <span className="inline-flex items-center gap-1.5">
                  <Phone size={14} strokeWidth={1.7} className="text-brand-700" />
                  {moNumber.phoneNumber}
                  {moNumber.keyword ? <span className="text-ink-400">({moNumber.keyword} 로 시작)</span> : null}
                </span>
              ) : (
                '배정 준비 중'
              )
            }
          />
          <DataRow label="신청 번호" value={ctx.phoneMasked} />
        </div>
      </Card>

      <Notice tone="danger" title="문자를 보내면 계좌에서 출금이 요청됩니다">
        등록을 마친 뒤 위 결제 수신번호로 문자를 보내면 후원 금액을 고르는 링크가 옵니다. 금액을 고르고 PIN 을
        입력해야 등록한 계좌에서 출금이 요청됩니다. 문자를 보내는 것만으로는 출금되지 않습니다.
      </Notice>

      <Card>
        <div className="mb-2 flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-50 text-brand-700">
            <Wallet size={17} strokeWidth={1.7} />
          </span>
          <CardTitle>후원 금액과 수수료</CardTitle>
        </div>
        <DataRow label="예시 후원 금액" value={`${formatWon(amount)} (실제 금액은 문자를 보낸 뒤 고릅니다)`} />
        <DataRow label="후원자 출금 금액" value="고른 후원 금액 그대로 (수수료 별도 부담 없음)" />
        <DataRow
          label="결제 수수료"
          value={`${pct(fees.pgFeeRate)}${pgFixed > 0n ? ` + ${formatWon(pgFixed)}` : ''} (${formatWon(fees.pgFeeSupply)})`}
        />
        <DataRow label="플랫폼 수수료" value={`${pct(fees.platformFeeRate)} (${formatWon(fees.platformFeeSupply)})`} />
        {fees.vat > 0n ? <DataRow label="수수료 부가세 (10%)" value={formatWon(fees.vat)} /> : null}
        <p className="mt-2 text-[12px] leading-relaxed text-ink-400">
          수수료{fees.vat > 0n ? '와 그 부가세는' : '는'} 사회복지기관 정산금에서 차감되며, 후원자는 고른 후원
          금액만 출금됩니다. 문자 발송 요금은 통신사 정책에 따라 별도로 부과될 수 있습니다.
        </p>
      </Card>

      <Card>
        <div className="mb-2 flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-50 text-brand-700">
            <MessageSquare size={17} strokeWidth={1.7} />
          </span>
          <CardTitle>이용 한도</CardTitle>
        </div>
        <DataRow label="1일 최대" value={formatWon(policy.payerDailyLimit)} />
        <DataRow label="1개월 최대" value={formatWon(policy.payerMonthlyLimit)} />
        <DataRow label="사회복지기관별 1일 최대" value={formatWon(policy.perMerchantDailyLimit)} />
        <DataRow label="신규 후원자 첫날 최대" value={formatWon(policy.newPayerFirstDayLimit)} />
        <DataRow
          label="연속 결제 제한"
          value={`${policy.velocityWindowSec}초 내 ${policy.velocityMaxCount}건`}
        />
        <p className="mt-2 text-[12px] leading-relaxed text-ink-400">
          한도를 초과하면 결제가 진행되지 않고 문자로 안내됩니다. 한도는 마이페이지에서 더 낮게 설정할 수 있습니다.
        </p>
      </Card>

      <Card>
        <div className="mb-2 flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-warning-50 text-warning-500">
            <AlertTriangle size={17} strokeWidth={1.7} />
          </span>
          <CardTitle>취소·환불과 이용 제한</CardTitle>
        </div>
        <ul className="space-y-2 text-[13px] leading-relaxed text-ink-700">
          <li>결제 완료 후 사회복지기관에 후원이 반영되기 전까지는 고객센터를 통해 취소를 요청할 수 있습니다.</li>
          <li>이미 후원이 반영된 결제는 원칙적으로 취소가 어려우며, 오류·중복 결제 등은 확인 후 환불 처리됩니다.</li>
          <li>환불은 출금된 계좌로 처리되며, 처리까지 영업일 기준 시간이 소요될 수 있습니다.</li>
          <li>결제 실패가 반복되면 이용이 일시 잠금되며, 관리자 확인 후 해제됩니다.</li>
          <li className="flex gap-2">
            <Ban size={16} strokeWidth={1.7} className="mt-0.5 shrink-0 text-danger-500" />
            <span>만 19세 미만은 이용할 수 없습니다. 본인 명의 계좌로만 등록해 주세요.</span>
          </li>
        </ul>
      </Card>

      <RegisterForm token={token} terms={terms} defaultName={defaultPayerName(ctx.phoneMasked)} />
    </div>
  );
}

// ------------------------------------------------------------- 결제 확인 화면

async function SelectAmountScreen({ token }: { token: string }) {
  const loaded = await loadSelectAmountContext(token);
  if (!loaded.ok) {
    return (
      <Card>
        <CardTitle>진행할 수 없습니다</CardTitle>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-500">{loaded.reason}</p>
      </Card>
    );
  }
  const ctx = loaded.ctx;

  // 결제 연동이 mock 이면 화면에 반드시 표시한다 (가짜 성공 처리 금지 원칙)
  let paymentMock = true;
  try {
    paymentMock = getPaymentAdapter().info().mode === 'mock';
  } catch {
    paymentMock = true;
  }

  return (
    <Card>
      <div className="mb-3 flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-50 text-brand-700">
          <Wallet size={17} strokeWidth={1.7} />
        </span>
        <CardTitle>{ctx.merchantName} 결제</CardTitle>
      </div>
      <SelectAmountPanel
        token={token}
        reconsent={ctx.reconsent}
        merchantName={ctx.merchantName}
        products={ctx.products.map((p) => ({
          id: p.id,
          kind: p.kind,
          digitalType: p.digitalType,
          name: p.name,
          amount: p.amount.toString(),
          description: p.description,
          imageUrl: p.imageUrl,
          images: p.images,
          give: p.give,
          withdrawalNotice: p.withdrawalNotice,
          documentName: p.documentName,
          stock: p.stock,
          soldOut: p.soldOut,
          maxPerOrder: p.maxPerOrder,
          options: p.options.map((o) => ({
            name: o.name,
            values: o.values.map((v) => ({ label: v.label, addPrice: v.addPrice.toString(), soldOut: v.soldOut })),
          })),
          shippingFee: p.shippingFee.toString(),
          freeReason: p.freeReason,
          freeShortfall: p.freeShortfall != null ? p.freeShortfall.toString() : null,
          dispatchDays: p.dispatchDays,
          returnFee: p.returnFee.toString(),
          exchangeFee: p.exchangeFee.toString(),
          payable: p.payable,
        }))}
        allowCustom={ctx.allowCustomAmount}
        minAmount={ctx.minAmount.toString()}
        maxAmount={ctx.maxAmount.toString()}
        customMin={ctx.customMin.toString()}
        customMax={ctx.customMax.toString()}
        customStep={ctx.customStep}
        message={ctx.message}
        paymentMock={paymentMock}
        shippingGuide={ctx.shipping.guide}
        carrier={ctx.shipping.carrier}
        remoteFee={ctx.shipping.remoteFee.toString()}
        campaigns={ctx.campaigns}
        defaultCampaignId={ctx.campaignId}
      />
    </Card>
  );
}


async function ConfirmScreen({ token }: { token: string }) {
  const loaded = await loadConfirmContext(token);
  if (!loaded.ok) {
    return (
      <Card>
        <CardTitle>확인을 진행할 수 없습니다</CardTitle>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-700">{loaded.reason}</p>
      </Card>
    );
  }
  const ctx = loaded.ctx;

  return (
    <ConfirmPanel
      token={token}
      merchantName={ctx.merchantName}
      amountText={formatWon(ctx.amount)}
      buttonText={`${formatWon(ctx.amount)} 후원하기`}
      message={ctx.message}
      expiresAtIso={ctx.expiresAt.toISOString()}
      payerId={ctx.payerId ?? undefined}
      payerNickname={ctx.payerNickname ?? undefined}
      payerSnsPlatform={ctx.payerSnsPlatform ?? undefined}
    />
  );
}
