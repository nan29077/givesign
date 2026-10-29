import type { Metadata } from 'next';
import Link from 'next/link';
import { CircleCheck, CircleX, CreditCard, Landmark, MessageSquare, RefreshCw, ShieldCheck } from 'lucide-react';
import { Card, CardTitle, DataRow, LinkButton, Notice } from '@/components/ui';
import { prisma } from '@/server/db';
import { tokenHash } from '@/lib/crypto';
import { completeRegistrationAction } from '@/app/actions/registration';
import { LinkShell } from '../link-shell';
import { CompleteRedirect } from '../complete-redirect';

/**
 * 결제창(현재는 Mock) 복귀 처리 화면.
 *
 * 주의
 *  - completeRegistration 은 보안링크를 1회용으로 소비한다.
 *    이미 완료된 등록이면 다시 실행하지 않고 결과만 안내한다.
 *  - 계좌번호 원문은 저장하지도, 화면에 노출하지도 않는다. 은행명 + 끝 4자리만 표시한다.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '기브싸인 계좌 등록 결과',
  robots: { index: false, follow: false },
};

type Search = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

export default async function RegistrationCompletePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Search>;
}) {
  const { token } = await params;
  const sp = await searchParams;

  const registrationId = one(sp.registrationId) || one(sp.ref);
  const tid = one(sp.tid);
  const bankCode = one(sp.bankCode);
  const bankName = one(sp.bankName);
  const account = one(sp.account);
  const failed = one(sp.fail) === '1' || one(sp.result) === 'FAIL';
  const failMessage = one(sp.message);

  if (!registrationId) {
    return (
      <LinkShell>
        <FailCard
          token={token}
          title="등록 정보를 확인할 수 없습니다"
          message="결제창에서 전달된 등록 정보가 없습니다. 처음부터 다시 시도해 주세요."
        />
      </LinkShell>
    );
  }

  const registration = await prisma.paymentRegistration.findUnique({ where: { id: registrationId } });
  // registrationId 는 결제창에서 돌아온 쿼리값이라 위조될 수 있다.
  // 이 링크(토큰)의 전화번호로 만든 등록 건일 때만 결과를 처리·표시한다.
  // (완료 후 새로고침하면 링크는 이미 사용 상태이므로 사용 여부와 무관하게 소유자만 대조한다)
  const [link, owner] = await Promise.all([
    prisma.secureLink.findUnique({
      where: { tokenHash: tokenHash(token) },
      // merchantId 는 완료 후 이동할 후원 페이지를 찾는 데 쓴다.
      // (등록 건에 사회복지기관이 비어 있는 예전 데이터의 대비책)
      select: { purpose: true, phoneHash: true, merchantId: true },
    }),
    registration
      ? prisma.payerProfile.findUnique({ where: { id: registration.payerId }, select: { phoneHash: true } })
      : Promise.resolve(null),
  ]);
  const owned = Boolean(
    registration && link && owner && link.purpose === 'REGISTER_ACCOUNT' && link.phoneHash === owner.phoneHash,
  );
  if (!registration || !owned) {
    return (
      <LinkShell>
        <FailCard
          token={token}
          title="등록 정보를 찾을 수 없습니다"
          message="등록 요청이 만료되었거나 존재하지 않습니다. 사회복지기관 번호로 문자를 다시 보내주세요."
        />
      </LinkShell>
    );
  }

  // 인증 실패로 복귀한 경우: 링크를 소비하지 않고 재시도를 안내한다.
  if (failed) {
    if (registration.status !== 'COMPLETED') {
      await prisma.paymentRegistration.update({
        where: { id: registration.id },
        data: {
          status: 'FAILED',
          resultCode: one(sp.code) || 'AUTH_FAILED',
          resultMessage: failMessage || '계좌 인증에 실패했습니다.',
        },
      });
    }
    return (
      <LinkShell>
        <FailCard
          token={token}
          title="계좌 인증이 완료되지 않았습니다"
          message={failMessage || '계좌 인증에 실패했습니다. 입력한 정보와 계좌 상태를 확인한 뒤 다시 시도해 주세요.'}
        />
      </LinkShell>
    );
  }

  // 이미 완료된 등록이면 재실행하지 않는다(1회용 링크 보호).
  let ok = registration.status === 'COMPLETED';
  let message: string | undefined;
  let resultIssuer: string | null = null;
  let resultTail4: string | null = null;
  // 계좌 빌키와 카드 빌링키를 같은 화면에서 다룬다. 표기 문구만 달라진다.
  let resultMethod: 'ACCOUNT' | 'CARD' = registration.method;

  if (ok) {
    const active = await prisma.paymentMethodToken.findFirst({
      where: { payerId: registration.payerId, status: 'ACTIVE' },
      orderBy: { registeredAt: 'desc' },
      select: { method: true, bankName: true, accountTail4: true, cardIssuer: true, cardTail4: true },
    });
    resultMethod = active?.method ?? resultMethod;
    resultIssuer = (resultMethod === 'CARD' ? active?.cardIssuer : active?.bankName) ?? null;
    resultTail4 = (resultMethod === 'CARD' ? active?.cardTail4 : active?.accountTail4) ?? null;
  } else {
    const res = await completeRegistrationAction({
      token,
      registrationId: registration.id,
      providerPayload: { tid, bankCode, bankName, account },
    });
    ok = res.ok;
    message = res.message;
    resultMethod = res.method ?? resultMethod;
    resultIssuer = (resultMethod === 'CARD' ? res.cardIssuer : res.bankName) ?? null;
    resultTail4 = (resultMethod === 'CARD' ? res.cardTail4 : res.accountTail4) ?? null;
  }

  if (!ok) {
    return (
      <LinkShell>
        <FailCard
          token={token}
          title={resultMethod === 'CARD' ? '카드 등록에 실패했습니다' : '계좌 등록에 실패했습니다'}
          message={message ?? '결제수단 등록을 완료하지 못했습니다.'}
        />
      </LinkShell>
    );
  }

  // 어느 사회복지기관으로 돌아가야 하는지: 등록 건에 기록된 값을 우선하고, 없으면 링크에 기록된 값을 쓴다.
  const merchantId = registration.merchantId ?? link?.merchantId ?? null;

  const merchant = merchantId
    ? await prisma.merchantProfile.findUnique({
        where: { id: merchantId },
        select: { code: true, displayName: true },
      })
    : null;

  const moNumber = merchantId
    ? await prisma.merchantMoNumber.findFirst({
        where: { merchantId, status: 'ASSIGNED' },
        select: { phoneNumber: true, keyword: true },
      })
    : null;

  return (
    <LinkShell>
      <div className="space-y-3">
        {/* 가입 완료 후에는 바로 문자를 보낼 수 있도록 사회복지기관 후원 페이지로 이동시킨다. */}
        {merchant ? <CompleteRedirect merchantCode={merchant.code} merchantName={merchant.displayName} /> : null}

        <Card>
          <div className="flex items-center gap-2 text-success-500">
            <CircleCheck size={20} strokeWidth={1.7} />
            <p className="text-[17px] font-extrabold text-ink-900">
              {resultMethod === 'CARD' ? '카드 등록이 완료되었습니다' : '계좌 등록이 완료되었습니다'}
            </p>
          </div>
          <div className="mt-3">
            <DataRow
              label={resultMethod === 'CARD' ? '등록 카드' : '등록 계좌'}
              value={
                <span className="inline-flex items-center gap-1.5">
                  {resultMethod === 'CARD' ? (
                    <CreditCard size={14} strokeWidth={1.7} className="text-brand-700" />
                  ) : (
                    <Landmark size={14} strokeWidth={1.7} className="text-brand-700" />
                  )}
                  {resultIssuer ?? (resultMethod === 'CARD' ? '등록 카드사' : '등록 은행')}{' '}
                  {resultTail4 ? `****${resultTail4}` : ''}
                </span>
              }
            />
            {merchant ? <DataRow label="결제 대상" value={merchant.displayName} /> : null}
            {moNumber ? (
              <DataRow
                label="결제 수신번호"
                value={
                  <span>
                    {moNumber.phoneNumber}
                    {moNumber.keyword ? <span className="text-ink-400"> ({moNumber.keyword} 로 시작)</span> : null}
                  </span>
                }
              />
            ) : null}
          </div>
          <p className="mt-3 text-[12px] leading-relaxed text-ink-400">
            {resultMethod === 'CARD'
              ? '카드번호 원문은 기브싸인에 저장되지 않습니다. 카드사명과 끝 4자리만 보관합니다.'
              : '계좌번호 원문은 기브싸인에 저장되지 않습니다. 은행명과 끝 4자리만 보관합니다.'}
          </p>
        </Card>

        <Notice tone="brand" title="이제 같은 번호로 문자를 보내면 결제가 접수됩니다">
          문자를 보내면 결제 PIN 입력 링크가 발송되고, PIN 을 입력하면 등록한
          {resultMethod === 'CARD' ? ' 카드로 결제 금액이 결제됩니다' : ' 계좌에서 결제 금액이 출금됩니다'}. 문자 1건마다
          결제가 요청되니 반복 발송에 주의해 주세요.
        </Notice>

        {moNumber ? (
          <a
            href={`sms:${moNumber.phoneNumber}`}
            className="inline-flex h-[52px] w-full items-center justify-center gap-2 rounded-2xl bg-brand-400 text-[15.5px] font-extrabold text-ink-900 shadow-[0_8px_20px_rgba(237,166,0,0.28)] transition-colors hover:bg-brand-500"
          >
            <MessageSquare size={17} strokeWidth={1.7} />
            바로 문자 보내러 가기
          </a>
        ) : null}

        {merchant ? (
          <LinkButton href={`/donate/${merchant.code}`} size="lg" variant="secondary">
            <MessageSquare size={17} strokeWidth={1.7} />
            {merchant.displayName} 후원 페이지 보기
          </LinkButton>
        ) : null}

        <Card>
          <div className="mb-2 flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-ink-50 text-brand-700">
              <ShieldCheck size={17} strokeWidth={1.7} />
            </span>
            <CardTitle>자동출금 해지 방법</CardTitle>
          </div>
          <ul className="space-y-2 text-[13px] leading-relaxed text-ink-700">
            <li>마이페이지의 결제수단 관리에서 등록한 계좌를 해지하면 이후 문자 결제가 진행되지 않습니다.</li>
            <li>고객센터로 해지를 요청하셔도 즉시 처리됩니다.</li>
            <li>해지 후에는 문자를 보내도 결제가 진행되지 않으며, 다시 이용하려면 계좌를 새로 등록해야 합니다.</li>
          </ul>
          <div className="mt-3 flex items-center gap-4">
            <Link href="/my/account" className="text-[13px] font-semibold text-brand-700">
              결제수단 관리
            </Link>
            <Link href="/support" className="text-[13px] font-semibold text-brand-700">
              고객센터 문의하기
            </Link>
          </div>
        </Card>
      </div>
    </LinkShell>
  );
}

function FailCard({ token, title, message }: { token: string; title: string; message: string }) {
  return (
    <div className="space-y-3">
      <Card>
        <div className="flex items-center gap-2 text-danger-500">
          <CircleX size={20} strokeWidth={1.7} />
          <p className="text-[16px] font-extrabold text-ink-900">{title}</p>
        </div>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-700">{message}</p>
        <div className="mt-3">
          <Notice tone="warning" title="출금은 발생하지 않았습니다">
            계좌 등록이 완료되지 않았으므로 어떠한 출금도 발생하지 않습니다. 등록 링크가 아직 유효하면 아래에서 다시
            시도할 수 있습니다.
          </Notice>
        </div>
      </Card>
      <LinkButton href={`/r/${token}`} size="lg" variant="secondary">
        <RefreshCw size={17} strokeWidth={1.7} />
        등록 다시 시도하기
      </LinkButton>
      <p className="text-center text-[12px] leading-relaxed text-ink-400">
        링크가 만료되었다면 사회복지기관 번호로 문자를 다시 보내주세요.
      </p>
    </div>
  );
}
