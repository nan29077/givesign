import type { Metadata } from 'next';
import Link from 'next/link';
import { LogIn } from 'lucide-react';
import { PublicShell } from '@/components/layout/public-shell';
import { PageHeader } from '@/components/public/page-header';
import { Button, Card, CardTitle, Field, Input, Notice, LinkButton } from '@/components/ui';
import { SocialAuthButtons } from '@/components/public/social-auth';
import { TestLoginPanel } from '@/components/public/test-login';
import { SOCIAL_LABEL, type SocialProvider } from '@/server/adapters/social';
import { isLocal } from '@/lib/env';

export const metadata: Metadata = {
  title: '로그인',
  description: '기브싸인 계정으로 로그인하고 후원 내역과 기관 운영 설정을 확인하세요.',
};

const ERROR_MESSAGES: Record<string, string> = {
  invalid: '이메일 또는 비밀번호가 올바르지 않습니다.',
  required: '이메일과 비밀번호를 모두 입력해 주세요.',
  suspended: '이용이 제한된 계정입니다. 고객센터로 문의해 주세요.',
  ratelimit: '로그인 시도가 많습니다. 잠시 후 다시 시도해 주세요.',
  session: '로그인이 필요한 페이지입니다. 로그인 후 다시 시도해 주세요.',
  social_unknown: '지원하지 않는 간편 로그인입니다.',
  social_error: '간편 로그인 처리 중 문제가 발생했습니다.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string; provider?: string; detail?: string }>;
}) {
  const sp = await searchParams;
  const providerLabel =
    sp.provider && sp.provider in SOCIAL_LABEL ? SOCIAL_LABEL[sp.provider as SocialProvider] : null;

  const errorText =
    sp.error === 'social_not_ready'
      ? `${providerLabel ?? '소셜'} 간편 로그인은 연동 준비 중입니다. 이메일로 로그인해 주세요.`
      : sp.error
        ? // 화이트리스트 밖의 값을 그대로 렌더하면 공격자가 정품 도메인 위에 임의 문구를
          // 띄울 수 있고(피싱), 깨진 퍼센트 인코딩은 decodeURIComponent 가 URIError 를 던져
          // 로그인 페이지 렌더 자체가 죽는다.
          (ERROR_MESSAGES[sp.error] ?? '로그인에 실패했습니다. 다시 시도해 주세요.')
        : null;

  // 테스트 로그인과 시드 계정 안내는 로컬 개발 환경에서만 노출한다.
  const showTestLogin = isLocal;

  return (
    <PublicShell aside={<LoginAside />}>
      <PageHeader
        eyebrow="로그인"
        title="기브싸인 계정으로 로그인"
        description="후원 내역, 결제 수단, 한도 설정은 로그인 후 확인할 수 있습니다."
      />

      {sp.next ? (
        <div className="mb-4">
          <Notice tone="brand">로그인하면 요청하신 페이지로 이동합니다.</Notice>
        </div>
      ) : null}

      {errorText ? (
        <div className="mb-4">
          <Notice tone="danger" title="로그인하지 못했습니다">
            {errorText}
          </Notice>
        </div>
      ) : null}

      <Card>
        <form method="post" action="/api/auth/login" className="space-y-4">
          {sp.next && sp.next.startsWith('/') && !sp.next.startsWith('//') ? (
            <input type="hidden" name="next" value={sp.next} />
          ) : null}
          <Field label="이메일" required>
            <Input
              type="email"
              name="email"
              required
              autoComplete="email"
              inputMode="email"
              placeholder="givesign@example.com"
            />
          </Field>
          <Field label="비밀번호" required>
            <Input type="password" name="password" required autoComplete="current-password" placeholder="비밀번호" />
          </Field>
          <Button type="submit" size="lg">
            로그인
            <LogIn size={16} strokeWidth={1.7} />
          </Button>
          <p className="text-center text-[13px] text-ink-500">
            <Link href="/reset-password" className="font-semibold text-brand-700">
              비밀번호 재설정
            </Link>
          </p>
        </form>

        <div className="mt-5">
          <SocialAuthButtons mode="login" />
        </div>

        <p className="mt-4 text-center text-[13px] text-ink-500">
          아직 계정이 없으신가요{' '}
          <Link href="/signup" className="font-semibold text-brand-700">
            후원자 회원가입
          </Link>
        </p>
      </Card>

      <div className="mt-4">
        <Notice tone="neutral" title="문자후원는 회원가입 없이도 이용할 수 있습니다">
          문자와 결제수단 등록만으로 결제할 수 있습니다. 회원가입은 후원 내역과 한도 설정을 웹에서 관리하기 위한 선택
          기능입니다.
        </Notice>
      </div>

      {showTestLogin ? (
        <div className="mt-4">
          <TestLoginPanel
            seedAccounts={[
              { email: 'admin@givesign.kr', password: 'givesign1234!' },
              { email: 'merchant1@givesign.kr', password: 'givesign1234!' },
            ]}
          />
        </div>
      ) : null}

    </PublicShell>
  );
}

function LoginAside() {
  return (
    <div className="sticky top-24 space-y-3">
      <Card>
        <CardTitle>비밀번호가 기억나지 않나요</CardTitle>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-500">
          현재 비밀번호 재설정은 고객센터 문의를 통해 처리하고 있습니다. 가입한 이메일과 함께 접수해 주세요.
        </p>
        <LinkButton href="/support" variant="secondary" size="md" className="mt-3 w-full">
          고객센터 문의
        </LinkButton>
      </Card>
      <Card>
        <CardTitle>사회복지기관이신가요</CardTitle>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-500">
          가입 신청 후 승인되면 사회복지기관 콘솔에서 결제 수신번호와 후원 설정을 관리할 수 있습니다.
        </p>
        <LinkButton href="/merchant-apply" variant="secondary" size="md" className="mt-3 w-full">
          사회복지기관 가입 신청
        </LinkButton>
      </Card>
    </div>
  );
}
