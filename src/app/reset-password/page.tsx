import type { Metadata } from 'next';
import { Card, CardTitle, Notice } from '@/components/ui';
import { PublicShell } from '@/components/layout/public-shell';
import { PageHeader } from '@/components/public/page-header';
import { RequestResetForm } from '@/components/public/password-reset-forms';

export const metadata: Metadata = {
  title: '비밀번호 재설정',
  description: '가입한 이메일로 비밀번호 재설정 링크를 받습니다.',
  robots: { index: false, follow: false },
};

export default function ResetPasswordPage() {
  return (
    <PublicShell aside={<ResetAside />}>
      <PageHeader
        eyebrow="비밀번호 재설정"
        title="비밀번호를 잊으셨나요"
        description="가입한 이메일로 재설정 링크를 보내 드립니다. 링크는 1시간 동안 한 번만 사용할 수 있습니다."
      />

      <Card>
        <RequestResetForm />
      </Card>

      <div className="mt-4">
        <Notice tone="neutral" title="이메일로 가입하지 않으셨다면">
          카카오·네이버 간편 로그인으로 가입한 계정에는 비밀번호가 없습니다. 해당 서비스에서 로그인해 주세요. 이메일과
          비밀번호를 모두 잊으셨다면 고객센터로 문의해 주시면 본인 확인 후 임시 비밀번호를 발급해 드립니다.
        </Notice>
      </div>
    </PublicShell>
  );
}

function ResetAside() {
  return (
    <div className="sticky top-24 space-y-3">
      <Card>
        <CardTitle>재설정 절차</CardTitle>
        <ol className="mt-3 space-y-2 text-[13px] leading-relaxed text-ink-500">
          <li>1. 가입한 이메일 주소를 입력합니다.</li>
          <li>2. 메일로 받은 재설정 링크를 엽니다.</li>
          <li>3. 새 비밀번호를 지정합니다.</li>
          <li>4. 기존 로그인 상태는 모두 해제되고, 새 비밀번호로 다시 로그인합니다.</li>
        </ol>
      </Card>
      <Card>
        <CardTitle>안전을 위한 처리</CardTitle>
        <ul className="mt-3 space-y-2 text-[13px] leading-relaxed text-ink-500">
          <li>재설정 링크는 1시간 동안만 유효합니다.</li>
          <li>한 번 사용한 링크는 다시 사용할 수 없습니다.</li>
          <li>새 링크를 발급하면 이전 링크는 즉시 무효가 됩니다.</li>
          <li>비밀번호가 바뀌면 모든 기기에서 로그아웃됩니다.</li>
        </ul>
      </Card>
    </div>
  );
}
