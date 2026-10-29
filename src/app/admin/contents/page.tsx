import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, EmptyState, Notice, SectionTitle, StatTile } from '@/components/ui';
import { AdminField, AdminInput, AdminSelect, AdminTextarea, FilterBar } from '@/components/admin/controls';
import { ActionButton, ActionForm } from '@/components/admin/action-form';
import { saveContentPost, deleteContentPost } from '@/app/actions/admin/content';
import { canWrite } from '@/components/admin/constants';
import { prisma } from '@/server/db';
import { requireAdmin } from '@/server/auth';
import { formatNumber } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import type { Prisma } from '@/generated/prisma/client';

export const dynamic = 'force-dynamic';

export default async function AdminContentsPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  // 레이아웃 가드에만 기대지 않는다. App Router 는 layout 과 page 를 함께 렌더하므로
  // 비관리자 요청에서도 이 페이지의 조회가 실행될 수 있다(스튜디오·마이페이지와 같은 규약).
  const me = await requireAdmin();
  // 서버 액션과 같은 기준으로 화면의 변경 컨트롤을 잠근다(눌러야 알게 되는 죽은 버튼 방지).
  const canEdit = canWrite(me.adminPermission);

  const sp = await searchParams;
  const type = sp.type === 'NOTICE' || sp.type === 'FAQ' ? sp.type : undefined;

  const where: Prisma.ContentPostWhereInput = type ? { type } : {};

  const [posts, noticeCount, faqCount, publishedCount] = await Promise.all([
    prisma.contentPost.findMany({
      where,
      orderBy: [{ pinned: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'desc' }],
      take: 100,
    }),
    prisma.contentPost.count({ where: { type: 'NOTICE' } }),
    prisma.contentPost.count({ where: { type: 'FAQ' } }),
    prisma.contentPost.count({ where: { published: true } }),
  ]);

  return (
    <>
      <PageHeader title="공지·FAQ 관리" description="공개 화면(/notice, /faq)에 노출되는 게시글을 관리합니다." />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile label="공지" value={formatNumber(noticeCount)} tone="brand" />
        <StatTile label="FAQ" value={formatNumber(faqCount)} />
        <StatTile label="공개중" value={formatNumber(publishedCount)} tone="success" />
        <StatTile label="현재 목록" value={formatNumber(posts.length)} />
      </div>

      <FilterBar action="/admin/contents" resetHref="/admin/contents">
        <AdminField label="유형" className="w-36">
          <AdminSelect name="type" defaultValue={type ?? ''}>
            <option value="">전체</option>
            <option value="NOTICE">공지</option>
            <option value="FAQ">FAQ</option>
          </AdminSelect>
        </AdminField>
      </FilterBar>

      <Notice tone="neutral" title="작성 시 유의사항">
        결제·환불·개인정보와 관련된 안내는 약관 및 실제 처리 로직과 일치해야 합니다. 확정되지 않은 외부 연동 기능을
        제공 중인 것처럼 표현하지 마세요.
      </Notice>

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardTitle>새 게시글</CardTitle>
          <div className="mt-3">
            <ActionForm disabled={!canEdit} action={saveContentPost} submitLabel="게시글 등록">
              <AdminField label="유형">
                <AdminSelect name="type" defaultValue="NOTICE">
                  <option value="NOTICE">공지</option>
                  <option value="FAQ">FAQ</option>
                </AdminSelect>
              </AdminField>
              <AdminField label="제목">
                <AdminInput name="title" required />
              </AdminField>
              <AdminField label="분류" hint="FAQ 카테고리 등 (선택)">
                <AdminInput name="category" placeholder="결제 / 환불 / 이용안내" />
              </AdminField>
              <AdminField label="본문">
                <AdminTextarea name="body" rows={6} required />
              </AdminField>
              <AdminField label="정렬 순서">
                <AdminInput name="sortOrder" inputMode="numeric" defaultValue="0" required />
              </AdminField>
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2 text-[13px] text-ink-700">
                  <input type="checkbox" name="published" defaultChecked className="h-4 w-4 rounded border-ink-300" />
                  공개
                </label>
                <label className="flex items-center gap-2 text-[13px] text-ink-700">
                  <input type="checkbox" name="pinned" className="h-4 w-4 rounded border-ink-300" />
                  상단 고정
                </label>
              </div>
            </ActionForm>
          </div>
        </Card>

        <div className="lg:col-span-2">
          <SectionTitle title="게시글 목록" description="상단 고정 → 정렬 순서 → 최신 순" />
          {posts.length === 0 ? (
            <EmptyState title="등록된 게시글이 없습니다" />
          ) : (
            <div className="space-y-3">
              {posts.map((p) => (
                <Card key={p.id}>
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={p.type === 'NOTICE' ? 'brand' : 'neutral'}>{p.type === 'NOTICE' ? '공지' : 'FAQ'}</Badge>
                      <CardTitle>{p.title}</CardTitle>
                      {p.pinned ? <Badge tone="warning">고정</Badge> : null}
                      <Badge tone={p.published ? 'success' : 'neutral'}>{p.published ? '공개' : '비공개'}</Badge>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-ink-400">수정 {formatKst(p.updatedAt, false)}</span>
                      <ActionButton disabled={!canEdit}
                        action={deleteContentPost}
                        values={{ id: p.id }}
                        label="삭제"
                        variant="danger"
                        confirm={`"${p.title}" 게시글을 삭제합니다.`}
                      />
                    </div>
                  </div>

                  <ActionForm disabled={!canEdit} action={saveContentPost} submitLabel="저장" variant="secondary">
                    <input type="hidden" name="id" value={p.id} />
                    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                      <AdminField label="유형">
                        <AdminSelect name="type" defaultValue={p.type === 'FAQ' ? 'FAQ' : 'NOTICE'}>
                          <option value="NOTICE">공지</option>
                          <option value="FAQ">FAQ</option>
                        </AdminSelect>
                      </AdminField>
                      <AdminField label="제목" className="lg:col-span-2">
                        <AdminInput name="title" defaultValue={p.title} required />
                      </AdminField>
                      <AdminField label="분류">
                        <AdminInput name="category" defaultValue={p.category ?? ''} />
                      </AdminField>
                    </div>
                    <AdminField label="본문">
                      <AdminTextarea name="body" rows={5} defaultValue={p.body} required />
                    </AdminField>
                    <div className="flex flex-wrap items-end gap-4">
                      <AdminField label="정렬 순서" className="w-28">
                        <AdminInput name="sortOrder" inputMode="numeric" defaultValue={String(p.sortOrder)} required />
                      </AdminField>
                      <label className="flex items-center gap-2 pb-2 text-[13px] text-ink-700">
                        <input
                          type="checkbox"
                          name="published"
                          defaultChecked={p.published}
                          className="h-4 w-4 rounded border-ink-300"
                        />
                        공개
                      </label>
                      <label className="flex items-center gap-2 pb-2 text-[13px] text-ink-700">
                        <input
                          type="checkbox"
                          name="pinned"
                          defaultChecked={p.pinned}
                          className="h-4 w-4 rounded border-ink-300"
                        />
                        상단 고정
                      </label>
                    </div>
                  </ActionForm>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
