import { prisma } from '@/server/db';
import { parseDocumentFields, presetOf } from '@/server/services/documents';
import type { ComposeTemplate } from '@/components/studio/edoc-compose';

/** 서명 요청에 쓸 수 있는 기관 서식(기본 서식이면 그 서식의 서명자 역할을 함께 준다). */
export async function composeTemplates(merchantId: string): Promise<ComposeTemplate[]> {
  const rows = await prisma.documentTemplate.findMany({
    where: { merchantId, active: true, archivedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true, description: true, presetKey: true, fields: true },
  });
  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    signers: presetOf(t.presetKey)?.signers ?? [],
    fieldCount: parseDocumentFields(t.fields).length,
  }));
}
