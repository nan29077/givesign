import Link from 'next/link';
import { Landmark, MessageSquare, CreditCard, SlidersHorizontal, Ban, FileText, ChevronRight } from 'lucide-react';
import { Card, CardTitle, Badge, Notice, DataRow, LinkButton, SectionTitle } from '@/components/ui';
import { RevokeForm } from '@/components/my/revoke-form';
import { PhoneLinkForm } from '@/components/my/phone-link-form';
import { NicknameForm } from '@/components/my/nickname-form';
import { defaultPayerName } from '@/lib/payer-name';
import { WithdrawForm } from '@/components/my/withdraw-form';
import { requirePayerContext } from '@/components/my/payer';
import { prisma } from '@/server/db';
import { formatKst } from '@/lib/datetime';
import { paymentMethodKindLabel } from '@/lib/labels';

export const dynamic = 'force-dynamic';

export default async function MyAccountPage() {
  const { payerId } = await requirePayerContext('/my/account');

  const payer = payerId
    ? await prisma.payerProfile.findUnique({
        where: { id: payerId },
        select: { phoneMasked: true, displayName: true },
      })
    : null;

  if (!payerId) {
    return (
      <div className="space-y-5" id="phone-link">
        <Notice tone="brand" title="휴대폰 번호를 연결해 주세요">
          문자후원 내역은 휴대전화 번호를 기준으로 기록됩니다. 아래에서 본인 번호를 인증하면 해당 번호의
          결제·후원 내역이 이 계정에 연결됩니다.
        </Notice>
        <PhoneLinkForm linkedPhoneMasked={null} />
      </div>
    );
  }

  const tokens = await prisma.paymentMethodToken.findMany({
    where: { payerId },
    orderBy: { registeredAt: 'desc' },
    take: 10,
    select: {
      id: true,
      method: true,
      bankName: true,
      accountTail4: true,
      cardIssuer: true,
      cardTail4: true,
      billKeyHint: true,
      status: true,
      registeredAt: true,
      revokedAt: true,
    },
  });

  const active = tokens.find((t) => t.status === 'ACTIVE') ?? null;
  const history = tokens.filter((t) => t.id !== active?.id);

  /** 계좌/카드 공통 표기. 원문은 저장하지 않으므로 발급처명과 끝 4자리만 보여준다. */
  const methodTitle = (m: 'ACCOUNT' | 'CARD') => (m === 'CARD' ? '발급사 · 카드' : '은행 · 계좌');
  const methodIssuer = (t: { method: 'ACCOUNT' | 'CARD'; bankName: string | null; cardIssuer: string | null }) =>
    t.method === 'CARD' ? t.cardIssuer ?? '등록 카드사' : t.bankName ?? '등록 은행';
  const methodTail = (t: { method: 'ACCOUNT' | 'CARD'; accountTail4: string | null; cardTail4: string | null }) =>
    (t.method === 'CARD' ? t.cardTail4 : t.accountTail4) ?? '****';

  return (
    <div className="space-y-5">
      <section id="phone-link">
        <SectionTitle
          title="휴대폰 번호"
          description="문자후원의 후원자 식별 기준입니다. 번호를 변경하면 새 번호의 내역이 표시됩니다."
        />
        <PhoneLinkForm linkedPhoneMasked={payer?.phoneMasked ?? null} />
      </section>

      {/*
        표시 이름.
        설정하지 않으면 번호 끝 4자리(후원자5678)로 표시되므로,
        번호 섹션 바로 아래에 두어 "번호 대신 이렇게 보인다"는 흐름으로 읽히게 한다.
      */}
      <section id="nickname">
        <SectionTitle
          title="표시 이름"
          description="후원 내역과 사회복지기관 화면에 표시되는 이름입니다."
        />
        <NicknameForm
          current={payer?.displayName ?? null}
          defaultName={defaultPayerName(payer?.phoneMasked ?? '')}
        />
      </section>

      {active ? (
        <Card className="border border-brand-100">
          <div className="flex items-start justify-between gap-3">
            <div className="flex gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700">
                <Landmark size={18} strokeWidth={1.7} />
              </span>
              <div>
                <CardTitle>{active.method === 'CARD' ? '등록된 결제 카드' : '등록된 출금 계좌'}</CardTitle>
                <p className="mt-1 text-[13px] text-ink-500">
                  {active.method === 'CARD'
                    ? '문자후원 시 이 카드로 결제 금액이 결제됩니다.'
                    : '문자후원 시 이 계좌에서 결제 금액이 출금됩니다.'}
                </p>
              </div>
            </div>
            <Badge tone="success">사용 중</Badge>
          </div>

          <div className="mt-4 rounded-2xl bg-ink-50 px-4 py-4">
            <p className="text-[12px] font-semibold text-ink-400">{methodTitle(active.method)}</p>
            <p className="mt-1 text-[20px] font-extrabold tracking-tight text-ink-900">
              {methodIssuer(active)} <span className="font-mono">****{methodTail(active)}</span>
            </p>
            <p className="mt-1 text-[12px] text-ink-400">
              {active.method === 'CARD'
                ? '카드번호 원문은 저장하지 않으며 끝 4자리만 표시합니다.'
                : '계좌번호 원문은 저장하지 않으며 끝 4자리만 표시합니다.'}
            </p>
          </div>

          <div className="mt-3">
            <DataRow label="결제수단" value={paymentMethodKindLabel[active.method]} />
            <DataRow label="등록 일시" value={formatKst(active.registeredAt, false)} />
            <DataRow label="결제수단 식별자" value={<span className="font-mono">{active.billKeyHint}</span>} />
            <DataRow label="자동출금 동의" value={<Badge tone="success">동의 중</Badge>} />
          </div>
        </Card>
      ) : (
        <Card>
          <div className="flex gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-ink-50 text-ink-400">
              <CreditCard size={18} strokeWidth={1.7} />
            </span>
            <div>
              <CardTitle>등록된 계좌가 없습니다</CardTitle>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-500">
                자동출금 동의가 해지되었거나 아직 계좌를 등록하지 않았습니다. 처음 등록이라면 사회복지기관의 결제 수신번호로
                문자를 보내면 등록 안내 문자가 발송되고, 해지한 뒤 다시 등록하려면 사회복지기관 후원 페이지에서 휴대폰 번호
                인증을 거쳐야 합니다.
              </p>
            </div>
          </div>
        </Card>
      )}

      {active ? (
        <section>
          <SectionTitle
            title="자동출금 동의 해지"
            description="해지하면 등록된 결제수단이 즉시 폐기되고 이후 문자후원이 접수되지 않습니다."
          />
          <Card>
            <Notice tone="warning" title="해지 전에 확인해 주세요">
              <ul className="list-disc space-y-1 pl-4">
                <li>이미 결제가 완료된 결제는 해지와 무관하게 유지됩니다.</li>
                <li>결제 확인을 기다리는 요청이 있다면 해지 후 결제되지 않습니다.</li>
                <li>다시 이용하려면 사회복지기관 후원 페이지에서 휴대폰 번호 인증을 거쳐 계좌를 새로 등록해야 합니다. (해지 후에는 문자만으로 등록 링크가 재발송되지 않습니다)</li>
              </ul>
            </Notice>
            <div className="mt-4">
              <RevokeForm />
            </div>
          </Card>
        </section>
      ) : (
        <section>
          <SectionTitle title="다시 이용하려면" />
          <Card>
            <div className="flex gap-3">
              <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700">
                <MessageSquare size={17} strokeWidth={1.7} />
              </span>
              <div>
                <p className="text-[13.5px] font-bold text-ink-900">계좌를 다시 등록하려면</p>
                <p className="mt-1 text-[12.5px] leading-relaxed text-ink-500">
                  <strong className="font-bold">처음 등록</strong>이라면 사회복지기관의 결제 수신번호로 문자를 보내면 계좌 등록용
                  1회용 보안 링크가 문자로 발송됩니다(이때 보낸 문자는 결제로 접수되지 않습니다).
                  <br />
                  <strong className="font-bold">해지한 뒤 다시 등록</strong>하려면 사회복지기관 후원 페이지에서 휴대폰 번호 인증을
                  거쳐 주세요. 안전을 위해 해지 이후에는 문자만으로 등록 링크를 다시 보내지 않습니다.
                </p>
                <LinkButton href="/how-it-works" variant="secondary" size="sm" className="mt-2.5">
                  등록 절차 자세히 보기
                </LinkButton>
              </div>
            </div>
          </Card>
        </section>
      )}

      {history.length > 0 ? (
        <section>
          <SectionTitle title="이전 등록 이력" />
          <div className="space-y-2">
            {history.map((t) => (
              <Card key={t.id} className="p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[13.5px] font-bold text-ink-900">
                      {methodIssuer(t)} <span className="font-mono">****{methodTail(t)}</span>
                    </p>
                    <p className="mt-0.5 text-[12px] text-ink-400">
                      등록 {formatKst(t.registeredAt, false)}
                      {t.revokedAt ? ` · 해지 ${formatKst(t.revokedAt, false)}` : ''}
                    </p>
                  </div>
                  <Badge tone={t.status === 'REVOKED' ? 'neutral' : 'warning'}>
                    {t.status === 'REVOKED' ? '해지됨' : '만료됨'}
                  </Badge>
                </div>
              </Card>
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <SectionTitle title="설정" description="결제 한도와 차단, 동의 이력을 관리합니다." />
        <Card padded={false}>
          <ul>
            {[
              { href: '/my/limits', label: '결제 한도', desc: '일일·월간 한도를 더 낮게 설정', icon: SlidersHorizontal },
              { href: '/my/blocks', label: '결제 차단', desc: '특정 사회복지기관 결제 차단', icon: Ban },
              { href: '/my/consents', label: '동의 이력', desc: '약관 동의 기록과 마케팅 수신', icon: FileText },
            ].map((m) => {
              const Icon = m.icon;
              return (
                <li key={m.href} className="border-b border-ink-100 last:border-0">
                  <Link
                    href={m.href}
                    className="flex items-center justify-between gap-3 px-4 py-3.5 transition-colors hover:bg-ink-50"
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-ink-50 text-ink-500">
                        <Icon size={16} strokeWidth={1.7} />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[13.5px] font-bold text-ink-900">{m.label}</span>
                        <span className="block truncate text-[12px] text-ink-400">{m.desc}</span>
                      </span>
                    </span>
                    <ChevronRight size={16} strokeWidth={1.8} className="shrink-0 text-ink-300" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      </section>

      <section>
        <WithdrawForm />
      </section>
    </div>
  );
}
