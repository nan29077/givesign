import type { Metadata } from 'next';
import { ChevronDown } from 'lucide-react';
import { PublicShell } from '@/components/layout/public-shell';
import { PageHeader } from '@/components/public/page-header';
import { Card, CardTitle, EmptyState, LinkButton, Badge } from '@/components/ui';
import { prisma } from '@/server/db';
import { isLegacyDonationContent } from '@/lib/public-content';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '자주 묻는 질문',
  description: '문자후원 이용, 계좌 등록, 한도, 환불, 후원 반영에 대해 자주 묻는 질문을 모았습니다.',
};

const UNCATEGORIZED = '기타';

export default async function FaqPage() {
  const allPosts = await prisma.contentPost.findMany({
    where: { type: 'FAQ', published: true },
    orderBy: { sortOrder: 'asc' },
  });
  const posts = allPosts.filter((post) => !isLegacyDonationContent(post));

  // category 별 그룹핑 (등장 순서 유지)
  const groups: Array<{ category: string; items: typeof posts }> = [];
  for (const p of posts) {
    const key = p.category?.trim() || UNCATEGORIZED;
    const found = groups.find((g) => g.category === key);
    if (found) found.items.push(p);
    else groups.push({ category: key, items: [p] });
  }

  return (
    <PublicShell aside={<FaqAside categories={groups.map((g) => ({ name: g.category, count: g.items.length }))} />}>
      <PageHeader
        eyebrow="FAQ"
        title="자주 묻는 질문"
        description="궁금한 항목을 눌러 답변을 확인하세요. 원하는 답을 찾지 못했다면 고객센터로 문의해 주세요."
      />

      {posts.length === 0 ? (
        <EmptyState title="등록된 FAQ가 없습니다" description="자주 묻는 질문이 준비되는 대로 안내해 드리겠습니다." />
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <section key={g.category} id={`faq-${encodeURIComponent(g.category)}`}>
              <div className="mb-2 flex items-center gap-2">
                <h2 className="text-[16px] font-extrabold tracking-tight text-ink-900">{g.category}</h2>
                <Badge tone="neutral">{g.items.length}</Badge>
              </div>
              <div className="space-y-2">
                {g.items.map((item) => (
                  <details key={item.id} className="card group p-4 [&_svg]:open:rotate-180">
                    <summary className="flex cursor-pointer list-none items-start justify-between gap-3">
                      <span className="text-[14px] font-bold leading-snug text-ink-900">{item.title}</span>
                      <ChevronDown
                        size={18}
                        strokeWidth={1.7}
                        className="mt-0.5 shrink-0 text-ink-400 transition-transform"
                      />
                    </summary>
                    <p className="mt-3 whitespace-pre-line border-t border-ink-100 pt-3 text-[13px] leading-relaxed text-ink-500">
                      {item.body}
                    </p>
                  </details>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <section className="mt-8">
        <Card>
          <CardTitle>답을 찾지 못하셨나요</CardTitle>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-500">
            결제 취소·환불, 계좌 등록 오류, 후원 반영 문제는 거래번호와 함께 문의해 주시면 더 빠르게 확인할 수 있습니다.
          </p>
          <LinkButton href="/support" variant="secondary" size="md" className="mt-3">
            고객센터 문의하기
          </LinkButton>
        </Card>
      </section>
    </PublicShell>
  );
}

function FaqAside({ categories }: { categories: Array<{ name: string; count: number }> }) {
  return (
    <div className="sticky top-24 space-y-3">
      <Card>
        <CardTitle>분류</CardTitle>
        <ul className="mt-3 space-y-1.5">
          {categories.map((c) => (
            <li key={c.name}>
              <a
                href={`#faq-${encodeURIComponent(c.name)}`}
                className="flex items-center justify-between rounded-lg px-2 py-1.5 text-[13px] font-semibold text-ink-500 hover:bg-ink-50 hover:text-ink-900"
              >
                <span>{c.name}</span>
                <span className="text-[12px] text-ink-300">{c.count}</span>
              </a>
            </li>
          ))}
          {categories.length === 0 ? <li className="text-[13px] text-ink-400">준비 중입니다.</li> : null}
        </ul>
      </Card>
      <Card>
        <CardTitle>바로가기</CardTitle>
        <div className="mt-3 space-y-2">
          <LinkButton href="/how-it-works" variant="secondary" size="md" className="w-full">
            이용방법 안내
          </LinkButton>
          <LinkButton href="/notice" variant="secondary" size="md" className="w-full">
            공지사항
          </LinkButton>
        </div>
      </Card>
    </div>
  );
}
