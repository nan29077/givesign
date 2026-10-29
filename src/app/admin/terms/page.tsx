import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, EmptyState, Notice, SectionTitle, StatTile, Table, Td, Th } from '@/components/ui';
import { AdminField, AdminInput, AdminSelect, AdminTextarea } from '@/components/admin/controls';
import { ActionForm } from '@/components/admin/action-form';
import { createTermsVersion } from '@/app/actions/admin/policy';
import { isSuperAdmin } from '@/components/admin/constants';
import { prisma } from '@/server/db';
import { requireAdmin } from '@/server/auth';
import { formatNumber } from '@/lib/money';
import { formatKst, kstDateKey } from '@/lib/datetime';
import type { ConsentType } from '@/generated/prisma/enums';

export const dynamic = 'force-dynamic';

const TYPES: Array<{ value: ConsentType; label: string }> = [
  { value: 'TERMS_SERVICE', label: '서비스 이용약관' },
  { value: 'PRIVACY', label: '개인정보 처리방침' },
  { value: 'E_FINANCE', label: '전자금융거래 이용약관' },
  { value: 'WITHDRAWAL_AGREE', label: '출금이체 동의' },
  { value: 'AGE_CONFIRM', label: '연령 확인' },
  { value: 'MARKETING', label: '마케팅 수신 동의' },
];

const typeLabel = Object.fromEntries(TYPES.map((t) => [t.value, t.label])) as Record<ConsentType, string>;

export default async function AdminTermsPage() {
  // 레이아웃 가드에만 기대지 않는다. App Router 는 layout 과 page 를 함께 렌더하므로
  // 비관리자 요청에서도 이 페이지의 조회가 실행될 수 있다(스튜디오·마이페이지와 같은 규약).
  const me = await requireAdmin();
  // 서버 액션과 같은 기준으로 화면의 변경 컨트롤을 잠근다(눌러야 알게 되는 죽은 버튼 방지).
  const canEdit = isSuperAdmin(me.adminPermission);

  const [versions, consentCounts] = await Promise.all([
    prisma.termsVersion.findMany({
      orderBy: [{ type: 'asc' }, { effectiveFrom: 'desc' }],
      take: 100,
      select: {
        id: true, type: true, version: true, title: true, required: true,
        effectiveFrom: true, active: true, createdAt: true,
        _count: { select: { consents: true } },
      },
    }),
    prisma.consentRecord.count(),
  ]);

  // 지금 적용 중인 버전 = 폐기되지 않았고(active) 시행일이 지난 것 중 유형별 최신 1건.
  // (새 버전을 등록해도 기존 버전을 내리지 않는다. 시행일이 되면 자동으로 넘어간다)
  const now = new Date();
  const currentIdByType = new Map<string, string>();
  for (const v of versions) {
    if (!v.active || v.effectiveFrom > now) continue;
    if (!currentIdByType.has(v.type)) currentIdByType.set(v.type, v.id);
  }
  const currentCount = currentIdByType.size;

  return (
    <>
      <PageHeader
        title="약관 버전 관리"
        description="현행 약관은 시행일로 정해집니다. 시행일을 미래로 두면 그날부터 자동으로 새 버전이 적용되고, 그전까지는 기존 버전이 그대로 게시됩니다."
      />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile label="전체 버전" value={formatNumber(versions.length)} />
        <StatTile label="시행 중" value={formatNumber(currentCount)} tone="success" />
        <StatTile label="약관 유형" value={formatNumber(TYPES.length)} />
        <StatTile label="누적 동의 기록" value={formatNumber(consentCounts)} tone="brand" />
      </div>

      <Notice tone="danger" title="기존 버전을 삭제하지 마세요">
        동의 이력(ConsentRecord)은 동의 당시의 약관 버전과 연결되어 보존됩니다. 버전을 삭제하면 어떤 내용에 동의했는지
        증명할 수 없게 되어 분쟁·감독 대응이 불가능해집니다. 내용 수정이 필요하면 반드시 새 버전을 등록하세요.
      </Notice>

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardTitle>새 버전 등록</CardTitle>
          <div className="mt-3">
            <ActionForm disabled={!canEdit}
              action={createTermsVersion}
              submitLabel="버전 등록"
              confirm="새 약관 버전을 등록합니다. 시행일이 되면 이 버전이 현행 약관이 됩니다."
            >
              <AdminField label="약관 유형">
                <AdminSelect name="type" defaultValue="TERMS_SERVICE">
                  {TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </AdminSelect>
              </AdminField>
              <AdminField label="버전" hint="1.0 또는 2026-01-01 형식">
                <AdminInput name="version" placeholder="1.0" required />
              </AdminField>
              <AdminField label="제목">
                <AdminInput name="title" required />
              </AdminField>
              <AdminField label="시행일 (KST)">
                <AdminInput type="date" name="effectiveFrom" defaultValue={kstDateKey()} />
              </AdminField>
              <AdminField label="본문">
                <AdminTextarea name="content" rows={10} required />
              </AdminField>
              <label className="flex items-center gap-2 text-[13px] text-ink-700">
                <input type="checkbox" name="required" defaultChecked className="h-4 w-4 rounded border-ink-300" />
                필수 동의 항목
              </label>
            </ActionForm>
          </div>
        </Card>

        <div className="lg:col-span-2">
          <SectionTitle title="약관 버전 목록" />
          {versions.length === 0 ? (
            <EmptyState title="등록된 약관 버전이 없습니다" />
          ) : (
            <Table className="min-w-[800px]">
              <thead>
                <tr>
                  <Th>유형</Th>
                  <Th>버전</Th>
                  <Th>제목</Th>
                  <Th>필수</Th>
                  <Th>시행일</Th>
                  <Th className="text-right">동의 건수</Th>
                  <Th>상태</Th>
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.id}>
                    <Td>{typeLabel[v.type] ?? v.type}</Td>
                    <Td className="font-mono text-[12px]">{v.version}</Td>
                    <Td className="max-w-[220px] break-words">{v.title}</Td>
                    <Td>
                      <Badge tone={v.required ? 'brand' : 'neutral'}>{v.required ? '필수' : '선택'}</Badge>
                    </Td>
                    <Td className="whitespace-nowrap">{formatKst(v.effectiveFrom, false)}</Td>
                    <Td className="text-right tabular-nums">{formatNumber(v._count.consents)}</Td>
                    <Td>
                      {!v.active ? (
                        <Badge tone="neutral">폐기</Badge>
                      ) : v.effectiveFrom > now ? (
                        <Badge tone="warning">시행 예정</Badge>
                      ) : currentIdByType.get(v.type) === v.id ? (
                        <Badge tone="success">시행 중</Badge>
                      ) : (
                        <Badge tone="neutral">지난 버전</Badge>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      </div>
    </>
  );
}
