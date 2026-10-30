'use server';
import { revalidatePath } from 'next/cache';
import { requireAdmin, writeAudit } from '@/server/auth';
import { prisma } from '@/server/db';
import { mainVisualSchema, MAIN_VISUAL_KEY } from '@/lib/visual-presets';
import type { AdminActionState } from '@/components/admin/state';

export async function saveMainVisuals(_prev: AdminActionState, f: FormData): Promise<AdminActionState> {
  try {
    const admin = await requireAdmin();
    if (admin.adminPermission !== 'SUPER_ADMIN') return { ok: false, message: '메인 여백 이미지 변경은 최고관리자만 가능합니다.' };
    const p = mainVisualSchema.safeParse({ activeIndex: f.get('activeIndex'), images: Array.from({ length: 5 }, (_, i) => String(f.get(`image${i}`) || '')) });
    if (!p.success) return { ok: false, message: p.error.issues[0].message };
    await prisma.systemSetting.upsert({ where: { key: MAIN_VISUAL_KEY }, create: { key: MAIN_VISUAL_KEY, value: p.data, updatedBy: admin.id }, update: { value: p.data, updatedBy: admin.id } });
    await writeAudit({ adminUserId: admin.id, action: 'MAIN_VISUALS_UPDATE', targetType: 'SystemSetting', targetId: MAIN_VISUAL_KEY, after: p.data });
    revalidatePath('/', 'layout');
    revalidatePath('/admin/appearance');
    return { ok: true, message: '메인 좌우 여백 이미지를 저장했습니다.' };
  } catch { return { ok: false, message: '저장하지 못했습니다. 관리자 권한과 입력값을 확인해 주세요.' }; }
}
