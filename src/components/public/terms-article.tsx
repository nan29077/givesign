import * as React from 'react';
import { Card, Badge, EmptyState, LinkButton } from '@/components/ui';
import { formatKst } from '@/lib/datetime';

export interface TermsDoc {
  version: string;
  title: string;
  content: string;
  effectiveFrom: Date;
  required: boolean;
}

/**
 * 약관 본문 렌더러.
 * DB(terms_version)에 활성 버전이 없으면 안내 문구를 표시한다.
 */
export function TermsArticle({ doc }: { doc: TermsDoc | null }) {
  if (!doc) {
    return (
      <div className="space-y-3">
        <EmptyState
          title="현재 게시된 약관이 없습니다"
          description="약관이 준비되는 대로 이 페이지에 게시됩니다. 급한 확인이 필요하면 고객센터로 문의해 주세요."
        />
        <LinkButton href="/support" variant="secondary" size="md" className="w-full">
          고객센터 문의
        </LinkButton>
      </div>
    );
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="brand">버전 {doc.version}</Badge>
        <Badge tone={doc.required ? 'warning' : 'neutral'}>{doc.required ? '필수 동의' : '선택 동의'}</Badge>
        <span className="text-[12px] text-ink-400">시행일 {formatKst(doc.effectiveFrom, false)}</span>
      </div>
      <h2 className="mt-3 text-[16px] font-extrabold tracking-tight text-ink-900">{doc.title}</h2>
      <article className="mt-3 whitespace-pre-line border-t border-ink-100 pt-4 text-[13.5px] leading-[1.85] text-ink-700">
        {doc.content}
      </article>
    </Card>
  );
}

export function TermsNav({ current }: { current: 'terms' | 'privacy' | 'e-finance' }) {
  const items: Array<{ key: 'terms' | 'privacy' | 'e-finance'; href: string; label: string }> = [
    { key: 'terms', href: '/terms', label: '이용약관' },
    { key: 'privacy', href: '/privacy', label: '개인정보처리방침' },
    { key: 'e-finance', href: '/terms/e-finance', label: '전자금융거래약관' },
  ];
  return (
    <div className="mb-5 flex flex-wrap gap-2">
      {items.map((i) => (
        <LinkButton
          key={i.key}
          href={i.href}
          variant={i.key === current ? 'primary' : 'secondary'}
          size="sm"
        >
          {i.label}
        </LinkButton>
      ))}
    </div>
  );
}
