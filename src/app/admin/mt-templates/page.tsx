import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, Notice, SectionTitle } from '@/components/ui';
import { AdminField, AdminTextarea } from '@/components/admin/controls';
import { ActionButton, ActionForm } from '@/components/admin/action-form';
import { saveMtTemplateAction, resetMtTemplateAction } from '@/app/actions/admin/mt-templates';
import { canManageTemplates } from '@/components/admin/constants';
import { prisma } from '@/server/db';
import { requireAdmin } from '@/server/auth';
import { formatKst } from '@/lib/datetime';
import {
  MT_TEMPLATE_BODY_MAX_LENGTH,
  MT_TEMPLATE_CODES,
  MT_TEMPLATE_META,
} from '@/server/services/mt-templates';

export const dynamic = 'force-dynamic';

/**
 * MT 문자 본문 관리.
 *
 * 여기서 저장한 본문이 코드 기본 문구를 대신해 실제 발송에 쓰인다(applyMtTemplateOverride).
 * 저장된 행이 없는 템플릿은 코드 기본 문구를 그대로 쓰므로, 이 화면을 한 번도 안 써도 동작은 같다.
 *
 * 발송 이력(어떤 문자가 실제로 나갔는지)은 /admin/mt-messages 에서 본다.
 */
export default async function AdminMtTemplatesPage() {
  // 레이아웃 가드에만 기대지 않는다. App Router 는 layout 과 page 를 함께 렌더하므로
  // 비관리자 요청에서도 이 페이지의 조회가 실행될 수 있다(스튜디오·마이페이지와 같은 규약).
  const me = await requireAdmin();
  // 서버 액션과 같은 기준으로 화면의 변경 컨트롤을 잠근다(눌러야 알게 되는 죽은 버튼 방지).
  const canEdit = canManageTemplates(me.adminPermission);

  const rows = await prisma.mtMessageTemplate.findMany({
    select: { code: true, body: true, updatedBy: true, updatedAt: true },
  });
  const saved = new Map(rows.map((r) => [r.code, r]));

  // 수정한 관리자 이름을 함께 보여준다 (누가 문구를 바꿨는지가 사고 추적의 시작점이다).
  const editorIds = [...new Set(rows.map((r) => r.updatedBy).filter((v): v is string => !!v))];
  const editors = editorIds.length
    ? await prisma.user.findMany({ where: { id: { in: editorIds } }, select: { id: true, name: true, email: true } })
    : [];
  const editorName = new Map(editors.map((u) => [u.id, u.name ?? u.email ?? u.id]));

  const editableCodes = MT_TEMPLATE_CODES.filter((c) => MT_TEMPLATE_META[c].editable);
  const lockedCodes = MT_TEMPLATE_CODES.filter((c) => !MT_TEMPLATE_META[c].editable);
  const customCount = editableCodes.filter((c) => saved.has(c)).length;

  return (
    <>
      <PageHeader
        title="MT 메시지 관리"
        description="후원자에게 나가는 안내 문자 본문을 여기서 고칩니다. 저장하면 재배포 없이 다음 발송부터 적용됩니다. 실제 발송 이력은 'MT 발송' 화면에서 확인하세요."
      />

      <div className="mb-4">
        <Notice tone="warning" title="저장한 문구가 그대로 후원자 휴대폰에 찍힙니다">
          발신 주체 표기(<span className="font-semibold">[기브싸인]</span>)는 본문 앞에 자동으로 붙습니다. &ldquo;결제되지
          않았습니다&rdquo; 같은 고지 문구를 지우면 후원자가 결제 여부를 오인할 수 있으니 문구를 바꿀 때 함께
          확인해 주세요. 현재 {editableCodes.length}개 중 {customCount}개가 커스텀 문구를 쓰고 있습니다.
        </Notice>
      </div>

      <SectionTitle
        title="수정 가능한 문자"
        description={`치환자는 대괄호가 아니라 중괄호({ }) 로 씁니다. 본문은 ${MT_TEMPLATE_BODY_MAX_LENGTH}자까지 입력할 수 있습니다.`}
      />

      <div className="mt-3 grid gap-4 xl:grid-cols-2">
        {editableCodes.map((code) => {
          const meta = MT_TEMPLATE_META[code];
          const row = saved.get(code);
          return (
            <Card key={code}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle>{meta.label}</CardTitle>
                <div className="flex items-center gap-1.5">
                  <Badge tone={row ? 'brand' : 'neutral'}>{row ? '커스텀 문구' : '기본 문구'}</Badge>
                  <span className="font-mono text-[11px] text-ink-400">{code}</span>
                </div>
              </div>

              <p className="mt-1 text-[12px] leading-relaxed text-ink-400">{meta.description}</p>

              <div className="mt-3 rounded-xl border border-ink-100 bg-ink-50 p-3">
                <p className="text-[11px] font-semibold text-ink-500">사용 가능한 치환자</p>
                {meta.variables.length === 0 ? (
                  <p className="mt-1 text-[12px] text-ink-400">이 문자에는 치환자가 없습니다.</p>
                ) : (
                  <ul className="mt-1.5 space-y-0.5">
                    {meta.variables.map((v) => (
                      <li key={v.token} className="text-[12px] text-ink-700">
                        <span className="font-mono font-semibold">{v.token}</span>
                        <span className="text-ink-400"> · {v.label}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-2 text-[11px] leading-relaxed text-ink-400">
                  기본 문구: {meta.defaultBody}
                </p>
              </div>

              <div className="mt-3">
                <ActionForm disabled={!canEdit} action={saveMtTemplateAction} submitLabel="본문 저장">
                  <input type="hidden" name="code" value={code} />
                  <AdminField
                    label="문자 본문"
                    hint={`최대 ${MT_TEMPLATE_BODY_MAX_LENGTH}자. 비우고 저장할 수는 없으며, 기본 문구로 되돌리려면 아래 초기화를 사용하세요.`}
                  >
                    <AdminTextarea
                      name="body"
                      rows={5}
                      maxLength={MT_TEMPLATE_BODY_MAX_LENGTH}
                      defaultValue={row?.body ?? meta.defaultBody}
                    />
                  </AdminField>
                </ActionForm>
              </div>

              {row ? (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-ink-100 pt-3">
                  <span className="text-[11px] text-ink-400">
                    최종 수정 {formatKst(row.updatedAt, false)}
                    {row.updatedBy ? ` · ${editorName.get(row.updatedBy) ?? row.updatedBy}` : ''}
                  </span>
                  <ActionButton disabled={!canEdit}
                    action={resetMtTemplateAction}
                    values={{ code }}
                    label="기본 문구로 초기화"
                    variant="danger"
                    confirm={`"${meta.label}" 문자를 코드 기본 문구로 되돌립니다. 저장한 내용은 사라집니다. 진행할까요?`}
                  />
                </div>
              ) : null}
            </Card>
          );
        })}
      </div>

      <section className="mt-6">
        <SectionTitle
          title="수정할 수 없는 문자"
          description="본문에 1회용 보안링크가 들어갑니다. 링크가 빠지거나 잘리면 등록·결제 흐름이 그대로 끊기므로 코드에서만 관리합니다."
        />
        <div className="mt-3 grid gap-4 xl:grid-cols-2">
          {lockedCodes.map((code) => {
            const meta = MT_TEMPLATE_META[code];
            return (
              <Card key={code}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle>{meta.label}</CardTitle>
                  <div className="flex items-center gap-1.5">
                    <Badge tone="neutral">읽기 전용</Badge>
                    <span className="font-mono text-[11px] text-ink-400">{code}</span>
                  </div>
                </div>
                <p className="mt-1 text-[12px] leading-relaxed text-ink-400">{meta.description}</p>
                <p className="mt-2 rounded-xl border border-ink-100 bg-ink-50 p-3 text-[12px] leading-relaxed text-ink-700">
                  {meta.defaultBody}
                </p>
              </Card>
            );
          })}
        </div>
      </section>
    </>
  );
}
