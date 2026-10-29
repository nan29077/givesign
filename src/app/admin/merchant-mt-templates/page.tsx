import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, Notice, SectionTitle } from '@/components/ui';
import { AdminField, AdminInput } from '@/components/admin/controls';
import { ActionForm } from '@/components/admin/action-form';
import {
  approveMerchantMtTemplate,
  rejectMerchantMtTemplate,
} from '@/app/actions/admin/merchant-mt-templates';
import { prisma } from '@/server/db';
import { requireAdmin } from '@/server/auth';
import { canManageMoney } from '@/components/admin/constants';
import { formatKst } from '@/lib/datetime';

export const dynamic = 'force-dynamic';

/**
 * 사회복지기관 발송 템플릿 검수.
 *
 * 사회복지기관이 등록한 템플릿 대부분은 자동 검사를 통과해 바로 승인된다.
 * 광고성 표현이나 금칙어가 걸린 것만 여기로 올라온다.
 *
 * 승인 판단이 왜 중요한가 — 광고성 문구를 승인하는 순간 사전 동의·야간 발송 제한·
 * 수신거부 의무가 따라오고, 스팸 신고가 쌓이면 제재받는 것은 우리 대표번호다.
 */
export default async function AdminMerchantMtTemplatesPage() {
  const me = await requireAdmin();
  // 서버 액션과 같은 기준으로 화면의 검수 버튼을 잠근다(눌러야 알게 되는 죽은 버튼 방지).
  const canReview = canManageMoney(me.adminPermission);

  const [pending, recent] = await Promise.all([
    prisma.merchantMtTemplate.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      include: { merchant: { select: { displayName: true, code: true } } },
    }),
    prisma.merchantMtTemplate.findMany({
      where: { status: { in: ['APPROVED', 'REJECTED'] } },
      orderBy: { updatedAt: 'desc' },
      take: 20,
      include: { merchant: { select: { displayName: true, code: true } } },
    }),
  ]);

  return (
    <>
      <PageHeader
        title="사회복지기관 발송 템플릿"
        description="사회복지기관이 연동 API 로 보내는 문자의 문구를 검수합니다. 자동 검사에 걸린 것만 올라옵니다."
      />

      <div className="space-y-4">
        <Notice tone="warning" title="광고성 문구는 승인하지 않습니다">
          사회복지기관 발송은 <strong>거래·주문·지급과 직접 관련된 안내</strong>만 허용합니다. 광고·홍보 문구를 승인하면
          사전 동의·야간 발송 제한·수신거부 의무가 따라오고, 스팸 신고가 쌓이면 제재받는 것은 사회복지기관이 아니라{' '}
          <strong>기브싸인 대표번호</strong>입니다. 광고성 발송은 별도 계약으로만 엽니다.
        </Notice>

        <SectionTitle title={`검수 대기 ${pending.length}건`} description="승인하면 즉시 발송에 쓸 수 있습니다." />

        {pending.length === 0 ? (
          <Card>
            <p className="text-[13px] text-ink-400">검수를 기다리는 템플릿이 없습니다.</p>
          </Card>
        ) : (
          <div className="space-y-3">
            {pending.map((t) => (
              <Card key={t.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="warning">검수 대기</Badge>
                  <span className="text-[13.5px] font-bold text-ink-900">{t.merchant.displayName}</span>
                  <code className="font-mono text-[11.5px] text-ink-500">
                    {t.merchant.code} · {t.code}
                  </code>
                  <span className="text-[11.5px] text-ink-400">{formatKst(t.createdAt)}</span>
                </div>

                <p className="mt-2 whitespace-pre-wrap rounded-xl border border-ink-100 bg-ink-50 px-3 py-2.5 text-[13px] leading-relaxed text-ink-800">
                  {t.body}
                </p>

                {t.reviewNote ? (
                  <p className="mt-2 text-[12.5px] leading-relaxed text-warning-500">
                    자동 검사: {t.reviewNote}
                  </p>
                ) : null}
                {t.variables ? (
                  <p className="mt-1 text-[11.5px] text-ink-400">
                    치환자: {t.variables.split(',').filter(Boolean).join(', ')}
                  </p>
                ) : null}

                {canReview ? (
                  <div className="mt-3 grid gap-3 lg:grid-cols-2">
                    <ActionForm action={approveMerchantMtTemplate} submitLabel="승인" variant="primary">
                      <input type="hidden" name="templateId" value={t.id} />
                      <AdminField label="승인 메모 (선택)">
                        <AdminInput name="note" maxLength={200} placeholder="거래 안내로 확인함" />
                      </AdminField>
                    </ActionForm>

                    <ActionForm action={rejectMerchantMtTemplate} submitLabel="반려" variant="danger">
                      <input type="hidden" name="templateId" value={t.id} />
                      <AdminField label="반려 사유 (필수)" hint="사회복지기관이 무엇을 고쳐야 하는지 적어 주세요.">
                        <AdminInput name="note" maxLength={200} placeholder="광고 문구는 보낼 수 없습니다" />
                      </AdminField>
                    </ActionForm>
                  </div>
                ) : (
                  <p className="mt-3 rounded-lg bg-ink-50 px-3 py-2 text-[12.5px] text-ink-500">
                    검수(승인·반려)는 최고관리자·운영·재무 권한에서만 할 수 있습니다.
                  </p>
                )}
              </Card>
            ))}
          </div>
        )}

        <SectionTitle title="최근 처리" description="최근 20건입니다." />
        <Card>
          {recent.length === 0 ? (
            <p className="text-[13px] text-ink-400">처리 이력이 없습니다.</p>
          ) : (
            <ul className="space-y-2">
              {recent.map((t) => (
                <li key={t.id} className="rounded-xl border border-ink-100 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    {t.status === 'APPROVED' ? (
                      <Badge tone="success">승인</Badge>
                    ) : (
                      <Badge tone="danger">반려</Badge>
                    )}
                    <span className="text-[12.5px] font-bold text-ink-900">{t.merchant.displayName}</span>
                    <code className="font-mono text-[11.5px] text-ink-500">{t.code}</code>
                    <span className="ml-auto text-[11.5px] text-ink-400">{formatKst(t.updatedAt)}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[12px] text-ink-500">{t.body}</p>
                  {t.reviewNote ? <p className="mt-0.5 text-[11.5px] text-ink-400">{t.reviewNote}</p> : null}
                  <p className="mt-0.5 text-[11.5px] text-ink-300">발송 {t.sentCount}건</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
