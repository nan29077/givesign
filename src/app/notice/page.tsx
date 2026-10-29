import type { Metadata } from 'next';
import { Megaphone, Pin } from 'lucide-react';
import { PublicShell } from '@/components/layout/public-shell';
import { PageHeader } from '@/components/public/page-header';
import { Card, CardTitle, EmptyState, Badge, LinkButton } from '@/components/ui';
import { formatKst } from '@/lib/datetime';
import { prisma } from '@/server/db';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '공지사항',
  description: '기브싸인 서비스 운영 공지와 점검, 정책 변경 안내를 확인하세요.',
};

export default async function NoticePage() {
  const posts = await prisma.contentPost.findMany({
    where: { type: 'NOTICE', published: true },
    orderBy: [{ pinned: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'desc' }],
  });

  return (
    <PublicShell aside={<NoticeAside />}>
      <PageHeader
        eyebrow="공지사항"
        title="서비스 안내"
        description="점검, 정책 변경, 이용 관련 중요한 내용을 이곳에 게시합니다."
      />

      {posts.length === 0 ? (
        <EmptyState title="등록된 공지사항이 없습니다" description="새로운 소식이 있으면 이곳에 안내해 드리겠습니다." />
      ) : (
        <div className="space-y-2.5">
          {posts.map((p) => (
            <Card key={p.id}>
              <div className="flex items-start gap-3">
                <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700">
                  {p.pinned ? <Pin size={17} strokeWidth={1.7} /> : <Megaphone size={17} strokeWidth={1.7} />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {p.pinned ? <Badge tone="brand">중요</Badge> : null}
                    {p.category ? <Badge tone="neutral">{p.category}</Badge> : null}
                    <span className="text-[12px] text-ink-400">{formatKst(p.createdAt, false)}</span>
                  </div>
                  <h2 className="mt-1.5 text-[15px] font-bold leading-snug text-ink-900">{p.title}</h2>
                  <p className="mt-2 whitespace-pre-line text-[13px] leading-relaxed text-ink-500">{p.body}</p>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </PublicShell>
  );
}

function NoticeAside() {
  return (
    <div className="sticky top-24 space-y-3">
      <Card>
        <CardTitle>운영 상태</CardTitle>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-500">
          기브싸인는 현재 준비 단계로, 실제 결제와 문자 발송은 비활성화되어 있습니다. 화면에 보이는 결제·문자 관련
          동작은 모의(mock) 처리입니다.
        </p>
      </Card>
      <Card>
        <CardTitle>바로가기</CardTitle>
        <div className="mt-3 space-y-2">
          <LinkButton href="/faq" variant="secondary" size="md" className="w-full">
            자주 묻는 질문
          </LinkButton>
          <LinkButton href="/support" variant="secondary" size="md" className="w-full">
            고객센터 문의
          </LinkButton>
        </div>
      </Card>
    </div>
  );
}
