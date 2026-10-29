import type { Metadata } from 'next';
import Link from 'next/link';
import { PublicShell } from '@/components/layout/public-shell';
import { PageHeader } from '@/components/public/page-header';
import { SignupForm } from '@/components/public/signup-form';
import { Card, CardTitle, Notice, LinkButton } from '@/components/ui';
import { SocialAuthButtons } from '@/components/public/social-auth';

export const metadata: Metadata = {
  title: '후원자 회원가입',
  description: '후원 내역과 결제 수단, 이용 한도를 웹에서 관리하려면 후원자 계정을 만들어 주세요.',
};

export default function SignupPage() {
  return (
    <PublicShell aside={<SignupAside />}>
      <PageHeader
        eyebrow="회원가입"
        title="후원자 회원가입"
        description="후원 내역 조회, 한도 설정, 자동출금 동의 관리를 위한 계정입니다."
      />

      <div className="mb-4">
        <Notice tone="brand" title="회원가입은 선택입니다">
          문자후원은 회원가입 없이 문자 발송과 계좌 등록만으로 이용할 수 있습니다. 회원가입은 이용 내역을 웹에서
          관리하기 위한 기능입니다.
        </Notice>
      </div>

      <Card>
        <SignupForm />

        <div className="mt-5">
          <SocialAuthButtons mode="signup" />
        </div>

        <p className="mt-4 text-center text-[13px] text-ink-500">
          이미 계정이 있으신가요{' '}
          <Link href="/login" className="font-semibold text-brand-700">
            로그인
          </Link>
        </p>
      </Card>

      <div className="mt-4">
        <Notice tone="warning" title="후원 내역 연결 안내">
          회원가입만으로는 기존 문자후원 내역이 자동으로 연결되지 않습니다. 후원 내역은 계좌 등록 시 사용한 휴대전화
          번호를 기준으로 연결되며, 연결이 필요하면 고객센터로 문의해 주세요.
        </Notice>
      </div>
    </PublicShell>
  );
}

function SignupAside() {
  return (
    <div className="sticky top-24 space-y-3">
      <Card>
        <CardTitle>계정으로 할 수 있는 일</CardTitle>
        <ul className="mt-3 space-y-2 text-[13px] leading-relaxed text-ink-500">
          <li>후원 내역과 거래번호 확인</li>
          <li>결제 승인·실패·환불 상태 조회</li>
          <li>등록 계좌 확인과 자동출금 동의 해지</li>
          <li>일일·월간 한도를 더 낮게 설정</li>
          <li>사회복지기관별 결제 차단</li>
          <li>약관 동의 이력 확인</li>
        </ul>
      </Card>
      <Card>
        <CardTitle>사회복지기관이신가요</CardTitle>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-500">
          결제 수신번호를 받으려면 사회복지기관 가입 신청이 필요합니다.
        </p>
        <LinkButton href="/merchant-apply" variant="secondary" size="md" className="mt-3 w-full">
          사회복지기관 가입 신청
        </LinkButton>
      </Card>
    </div>
  );
}
