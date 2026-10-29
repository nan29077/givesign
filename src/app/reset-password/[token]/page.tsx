import type { Metadata } from 'next';
import Link from 'next/link';
import { Card, CardTitle, Notice } from '@/components/ui';
import { PublicShell } from '@/components/layout/public-shell';
import { PageHeader } from '@/components/public/page-header';
import { ConfirmResetForm } from '@/components/public/password-reset-forms';
import { loadResetToken } from '@/server/services/password-reset';

/**
 * 재설정 링크 진입 화면.
 *
 * 토큰은 URL 경로에만 존재하고 화면에는 다시 노출하지 않는다.
 * 만료·사용됨·없음을 구분해 안내하되, 어느 계정의 링크인지는 마스킹된 이메일로만 보여 준다.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '새 비밀번호 설정',
  robots: { index: false, follow: false },
};

const INVALID_MESSAGE: Record<string, string> = {
  NOT_FOUND: '유효하지 않은 링크입니다. 링크가 잘못되었거나 이미 새 링크가 발급되었습니다.',
  EXPIRED: '재설정 링크가 만료되었습니다. 링크는 발급 후 1시간 동안만 사용할 수 있습니다.',
  USED: '이미 사용된 링크입니다. 비밀번호를 다시 바꾸려면 재설정을 새로 요청해 주세요.',
};

export default async function ResetPasswordConfirmPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const loaded = await loadResetToken(token);

  return (
    <PublicShell aside={<ConfirmAside />}>
      <PageHeader
        eyebrow="비밀번호 재설정"
        title="새 비밀번호 설정"
        description="새 비밀번호를 지정하면 이 계정의 기존 로그인 상태가 모두 해제됩니다."
      />

      <Card>
        {loaded.state === 'VALID' ? (
          <ConfirmResetForm token={token} emailMasked={loaded.emailMasked ?? '-'} />
        ) : (
          <div className="space-y-3">
            <Notice tone="danger" title="이 링크로는 비밀번호를 바꿀 수 없습니다">
              {INVALID_MESSAGE[loaded.state] ?? INVALID_MESSAGE.NOT_FOUND}
            </Notice>
            <p className="text-center text-[13px] text-ink-500">
              <Link href="/reset-password" className="font-semibold text-brand-700">
                재설정 다시 요청하기
              </Link>
            </p>
          </div>
        )}
      </Card>
    </PublicShell>
  );
}

function ConfirmAside() {
  return (
    <div className="sticky top-24 space-y-3">
      <Card>
        <CardTitle>비밀번호 만들기</CardTitle>
        <ul className="mt-3 space-y-2 text-[13px] leading-relaxed text-ink-500">
          <li>8자 이상으로 지정해 주세요.</li>
          <li>다른 사이트와 같은 비밀번호는 쓰지 마세요.</li>
          <li>이름·생년월일·전화번호가 들어간 비밀번호는 피해 주세요.</li>
        </ul>
      </Card>
      <Card>
        <CardTitle>변경 후에는</CardTitle>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-500">
          PC·모바일을 포함한 모든 기기에서 로그아웃됩니다. 본인이 요청하지 않은 재설정이라면 링크를 사용하지 마시고
          고객센터로 알려 주세요.
        </p>
      </Card>
    </div>
  );
}
