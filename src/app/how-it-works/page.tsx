import type { Metadata } from 'next';
import {
  MessageSquare, CreditCard, ShieldCheck, BellRing, Ban, Gauge,
  Undo2, ScrollText, CircleAlert, Landmark, Clock, Smartphone, Repeat, FileText,
} from 'lucide-react';
import { PublicShell } from '@/components/layout/public-shell';
import { PageHeader } from '@/components/public/page-header';
import { Card, CardTitle, SectionTitle, Notice, LinkButton, DataRow } from '@/components/ui';
import { formatWon, formatNumber } from '@/lib/money';
import { resolvePolicy } from '@/server/services/limits';
import { RECURRING_MAX_AMOUNT, RECURRING_MAX_ATTEMPTS, RECURRING_MIN_AMOUNT } from '@/server/services/recurring';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '문자후원 이용안내',
  description: '문자 한 통으로 사회복지기관에 후원하는 방법, 출금 시점, 이용 한도, 환불, 정기후원과 기부금영수증을 안내합니다.',
};

/**
 * 이용안내.
 * 홈 개편 때 한 줄짜리 안내로 줄어들며 사라졌던 정책 고지(이용 한도 표, 출금 시점, 환불 제한 사유,
 * 만 19세 미만 이용 제한)를 후원 서비스 용어로 복원한다(2026-10-29 점검 M-23).
 * 한도 숫자는 현재 정책값을 그대로 읽어 화면과 실제 동작이 어긋나지 않게 한다.
 */
export default async function HowItWorksPage() {
  const policy = await resolvePolicy();

  return (
    <PublicShell aside={<HowAside />}>
      <PageHeader
        eyebrow="이용안내"
        title="문자 한 통으로 후원하는 전체 과정"
        description="최초 1회 계좌 등록만 마치면, 그 다음부터는 기관 번호로 문자를 보내고 금액을 확인하는 것으로 후원이 끝납니다."
      />

      <Notice tone="warning" title="시작하기 전에 꼭 확인해 주세요">
        <ul className="list-disc space-y-1 pl-4">
          <li>처음 보내는 문자로는 후원되지 않습니다. 계좌 등록 안내만 발송됩니다.</li>
          <li>등록을 마친 뒤에도 문자를 보내는 것만으로는 출금되지 않습니다. 안내 링크에서 금액을 확인하고 PIN 을 입력해야 출금됩니다.</li>
          <li>후원은 기부입니다. 상품이나 포인트를 받는 거래가 아니며, 기부금영수증은 발급 자격이 확인된 기관만 발급합니다.</li>
        </ul>
      </Notice>

      <section className="mt-8">
        <SectionTitle title="후원 절차" description="처음 한 번만 등록하면 이후에는 2단계를 건너뜁니다." />
        <div className="space-y-2.5">
          <Step
            no={1}
            icon={<MessageSquare size={18} strokeWidth={1.7} />}
            title="기관의 후원 문자 번호로 문자 보내기"
            body="기관 후원페이지의 문자후원 버튼을 누르거나 기관이 안내한 번호로 문자를 보냅니다. 대표번호를 쓰는 기관은 메시지 맨 앞에 기관 키워드를, 캠페인을 지정하려면 캠페인 키워드를 붙입니다."
            note="처음 보내는 문자로는 후원되지 않으며 출금도 없습니다."
            noteTone="warning"
          />
          <Step
            no={2}
            icon={<CreditCard size={18} strokeWidth={1.7} />}
            title="안내 문자의 링크에서 계좌 등록 (최초 1회)"
            body="문자로 받은 1회용 보안 링크를 열어 본인 명의 계좌를 등록하고 이용 동의를 진행합니다. 등록 화면에서 후원 대상, 이용 한도, 취소·환불 조건을 모두 확인할 수 있습니다."
            note="계좌번호 원문은 기브싸인에 저장하지 않습니다. 은행명과 계좌 끝 4자리만 보관합니다."
          />
          <Step
            no={3}
            icon={<ShieldCheck size={18} strokeWidth={1.7} />}
            title="금액을 고르고 PIN 인증으로 후원"
            body="등록을 마친 뒤 문자를 보내면 금액 선택 링크가 도착합니다. 기관이 정한 후원 항목이나 직접 입력 금액을 고르고, 결제사 화면에서 PIN 을 입력하는 순간 등록한 계좌에서 후원 금액이 출금됩니다."
            note="PIN 을 입력하지 않은 요청은 일정 시간이 지나면 자동으로 만료되고 출금되지 않습니다."
          />
          <Step
            no={4}
            icon={<BellRing size={18} strokeWidth={1.7} />}
            title="후원 완료 안내와 내역 확인"
            body="출금이 완료되면 감사 문자를 받습니다. 후원 내역·누적 후원액·기부금영수증은 마이페이지에서 확인할 수 있고, 기관은 마스킹된 번호와 표시 이름만 봅니다."
            note="전화번호·계좌번호나 금칙어가 포함된 메시지는 일부 문구가 가려질 수 있습니다. 후원 자체는 정상 처리됩니다."
          />
        </div>
      </section>

      <section className="mt-8">
        <SectionTitle title="언제 돈이 빠져나가나요" description="출금 시점을 정확히 알고 이용하세요." />
        <Card>
          <div className="space-y-3">
            <Line
              icon={<Ban size={17} strokeWidth={1.7} />}
              tone="warning"
              title="처음 보내는 문자 — 출금 없음"
              body="계좌 등록 전에 보낸 문자는 후원으로 처리되지 않으며 요금이 청구되지 않습니다. (이동통신사 문자 발송 요금은 별도)"
            />
            <Line
              icon={<Landmark size={17} strokeWidth={1.7} />}
              tone="danger"
              title="등록 후 문자 — 금액 확인과 PIN 입력 시 출금"
              body="계좌 등록을 마친 뒤 보내는 문자는 금액 선택 링크를 받고, PIN 인증을 거친 뒤에야 등록한 계좌에서 출금됩니다."
            />
            <Line
              icon={<Clock size={17} strokeWidth={1.7} />}
              tone="neutral"
              title="PIN 을 입력하지 않은 요청 — 자동 만료"
              body="PIN 을 입력하지 않으면 요청은 만료되고 출금되지 않습니다. 만료된 요청은 후원 내역·영수증에도 반영되지 않습니다."
            />
            <Line
              icon={<Repeat size={17} strokeWidth={1.7} />}
              tone="neutral"
              title="정기후원 — 매월 정한 날에 자동 출금"
              body="정기후원은 신청 화면에서 별도로 동의한 경우에만 시작되며, 한 달에 한 번만 출금됩니다. 마이페이지에서 언제든 멈출 수 있습니다."
            />
          </div>
        </Card>
      </section>

      <section className="mt-8">
        <SectionTitle
          title="이용 한도"
          description="과도한 출금을 막기 위한 기본 한도입니다. 기관별 한도가 더 낮을 수 있고, 마이페이지에서 더 낮게 설정할 수 있습니다."
        />
        <Card>
          <DataRow label="1건 허용 범위" value={`${formatWon(policy.minAmount)} ~ ${formatWon(policy.maxAmount)}`} />
          <DataRow label="1일 최대" value={formatWon(policy.payerDailyLimit)} />
          <DataRow label="1개월 최대" value={formatWon(policy.payerMonthlyLimit)} />
          <DataRow label="한 기관에 1일 최대" value={formatWon(policy.perMerchantDailyLimit)} />
          <DataRow
            label="연속 후원 제한"
            value={`${formatNumber(policy.velocityWindowSec)}초 내 ${formatNumber(policy.velocityMaxCount)}건`}
          />
          <DataRow
            label="연속 후원 시 대기"
            value={`${formatNumber(policy.cooldownAfterCount)}건 이후 ${formatNumber(policy.cooldownSec)}초 대기`}
          />
          <DataRow label="신규 후원자 첫날 한도" value={formatWon(policy.newPayerFirstDayLimit)} />
          <DataRow label="출금 실패 누적" value={`${formatNumber(policy.failureLockThreshold)}회 시 자동 잠금`} />
          <DataRow label="정기후원 1건 범위" value={`${formatWon(RECURRING_MIN_AMOUNT)} ~ ${formatWon(RECURRING_MAX_AMOUNT)} (위 한도 안에서)`} />
        </Card>
        <p className="mt-2 flex gap-2 text-[12px] leading-relaxed text-ink-400">
          <Gauge size={15} strokeWidth={1.7} className="mt-0.5 shrink-0" />
          <span>한도를 넘는 요청은 후원으로 접수되지 않고 안내 문자가 발송됩니다. 이미 완료된 후원은 한도 변경의 영향을 받지 않습니다.</span>
        </p>
      </section>

      <section className="mt-8">
        <SectionTitle title="취소 및 환불" />
        <Card>
          <div className="space-y-3">
            <Line
              icon={<Undo2 size={17} strokeWidth={1.7} />}
              tone="neutral"
              title="환불 요청 방법"
              body="마이페이지 후원 내역에서 완료 건의 환불을 요청하거나, 고객센터로 거래번호와 함께 접수해 주세요. 기관은 환불을 요청만 할 수 있고 실행은 관리자 승인으로 이루어집니다."
            />
            <Line
              icon={<CircleAlert size={17} strokeWidth={1.7} />}
              tone="warning"
              title="환불이 제한되는 경우"
              body="기부금은 완료 후 원칙적으로 반환을 청구할 수 없습니다. 착오·금액 오입력·미성년자 미동의·명의 도용 같은 정당한 사유는 환불되며, 그 밖에는 기관의 환불 정책에 따릅니다. 이미 기관에 정산된 건, 부정 이용이 확인된 건, 본인 확인이 어려운 건은 제한될 수 있습니다."
            />
            <Line
              icon={<ScrollText size={17} strokeWidth={1.7} />}
              tone="neutral"
              title="영수증이 이미 발급된 후원의 환불"
              body="환불된 후원이 포함된 기부금영수증은 무효 처리되고 남은 후원으로 다시 발급됩니다. 무효 처리된 영수증은 연말정산에 쓸 수 없습니다."
            />
          </div>
        </Card>
      </section>

      <section className="mt-8">
        <SectionTitle title="정기후원과 기부금영수증" />
        <Card>
          <div className="space-y-3">
            <Line
              icon={<Repeat size={17} strokeWidth={1.7} />}
              tone="neutral"
              title="정기후원"
              body={`기관 후원페이지에서 금액과 출금일(1~28일)을 정해 신청합니다. 출금이 실패하면 3일 간격으로 최대 ${RECURRING_MAX_ATTEMPTS}회 다시 시도하고, 모두 실패하면 자동으로 멈추고 문자로 안내합니다. 등록 계좌를 해지하면 정기후원도 함께 멈춥니다.`}
            />
            <Line
              icon={<FileText size={17} strokeWidth={1.7} />}
              tone="neutral"
              title="기부금영수증"
              body="마이페이지에서 성명·주민등록번호를 등록(별도 동의)하면, 발급 자격이 확인된 기관이 연말에 영수증을 발급하고 국세청 간소화 자료로 제출합니다. 등록하지 않아도 후원에는 제한이 없습니다."
            />
          </div>
        </Card>
      </section>

      <section className="mt-8">
        <SectionTitle title="미성년자 이용 제한" />
        <Notice tone="danger" title="만 19세 미만은 이용할 수 없습니다">
          기브싸인 문자후원은 만 19세 이상만 이용할 수 있습니다. 계좌 등록 시 연령 확인에 동의해야 하며, 명의자 동의 없이
          이루어진 후원은 확인 즉시 이용이 정지되고 환불 절차가 진행됩니다. 가족 명의 휴대전화나 계좌를 무단으로 사용하지 마세요.
        </Notice>
      </section>

      <section className="mt-8">
        <Card>
          <div className="flex gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-ink-50 text-brand-700">
              <Smartphone size={17} strokeWidth={1.7} />
            </span>
            <div>
              <CardTitle>문자 발송 요금 안내</CardTitle>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-500">
                후원 금액과 별개로 이동통신사의 문자 발송 요금이 발생할 수 있습니다. 요금 정책은 가입한 통신 요금제를 확인해 주세요.
              </p>
            </div>
          </div>
        </Card>
      </section>

      <section className="mt-8">
        <Card className="bg-ink-900 text-white">
          <p className="text-[15px] font-extrabold leading-snug">후원할 기관의 코드를 알고 계신가요?</p>
          <p className="mt-1.5 text-[13px] leading-relaxed opacity-90">
            기관이 안내한 코드를 입력하면 후원 문자 번호와 후원페이지를 바로 확인할 수 있습니다.
          </p>
          <LinkButton href="/" variant="secondary" size="lg" className="mt-4">
            기관 코드 입력하기
          </LinkButton>
        </Card>
      </section>
    </PublicShell>
  );
}

function Step({
  no, icon, title, body, note, noteTone = 'neutral',
}: {
  no: number;
  icon: React.ReactNode;
  title: string;
  body: string;
  note?: string;
  noteTone?: 'neutral' | 'warning';
}) {
  return (
    <Card className="flex gap-3">
      <span className="relative grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700">
        {icon}
        <span className="absolute -right-1 -top-1 grid h-5 w-5 place-items-center rounded-full bg-ink-900 text-[11px] font-bold text-white">
          {no}
        </span>
      </span>
      <div className="min-w-0">
        <p className="text-[14.5px] font-bold text-ink-900">{title}</p>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-500">{body}</p>
        {note ? (
          <p
            className={
              noteTone === 'warning'
                ? 'mt-2 rounded-lg bg-warning-50 px-3 py-2 text-[12.5px] leading-relaxed font-semibold text-ink-900'
                : 'mt-2 rounded-lg bg-ink-50 px-3 py-2 text-[12.5px] leading-relaxed text-ink-700'
            }
          >
            {note}
          </p>
        ) : null}
      </div>
    </Card>
  );
}

function Line({
  icon, title, body, tone,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  tone: 'neutral' | 'warning' | 'danger';
}) {
  const badge =
    tone === 'danger' ? 'bg-danger-50 text-danger-500'
    : tone === 'warning' ? 'bg-warning-50 text-warning-500'
    : 'bg-ink-50 text-brand-700';
  return (
    <div className="flex gap-3">
      <span className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg ${badge}`}>{icon}</span>
      <div>
        <p className="text-[13.5px] font-bold text-ink-900">{title}</p>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-500">{body}</p>
      </div>
    </div>
  );
}

function HowAside() {
  return (
    <div className="sticky top-24 space-y-3">
      <Card>
        <CardTitle>한눈에 보기</CardTitle>
        <ol className="mt-3 space-y-2 text-[13px] leading-relaxed text-ink-500">
          <li>1. 기관 번호로 문자 발송</li>
          <li>2. 안내 링크에서 계좌 등록 (최초 1회)</li>
          <li>3. 금액 선택 후 PIN 입력으로 출금</li>
          <li>4. 감사 문자와 마이페이지에서 확인</li>
        </ol>
      </Card>
      <Card>
        <CardTitle>도움이 더 필요하신가요</CardTitle>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-500">자주 묻는 질문에서 답을 찾지 못했다면 고객센터로 문의해 주세요.</p>
        <div className="mt-3 space-y-2">
          <LinkButton href="/faq" variant="secondary" size="md" className="w-full">자주 묻는 질문</LinkButton>
          <LinkButton href="/support" variant="secondary" size="md" className="w-full">고객센터 문의</LinkButton>
        </div>
      </Card>
    </div>
  );
}
