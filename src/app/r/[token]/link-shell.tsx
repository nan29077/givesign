import * as React from 'react';
import { Logo } from '@/components/brand/logo';

/**
 * 보안링크 전용 미니멀 레이아웃.
 * MT 문자로 진입하는 모바일 화면이므로 공용 PublicShell(헤더/내비게이션)을 사용하지 않는다.
 */
export function LinkShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-ink-50 px-4 pb-14 pt-6">
      <div className="app-column">
        <div className="mb-4 flex items-center justify-between">
          <Logo />
          <span className="text-[11px] font-semibold text-ink-300">보안 링크</span>
        </div>
        {children}
        <p className="mt-6 text-center text-[11px] leading-relaxed text-ink-300">
          이 링크는 본인에게만 발송된 1회용 링크입니다. 다른 사람에게 전달하지 마세요.
        </p>
      </div>
    </main>
  );
}
