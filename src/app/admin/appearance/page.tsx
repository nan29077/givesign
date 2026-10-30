import Link from 'next/link';
import Image from 'next/image';
import { requireAdmin } from '@/server/auth';
import { getMainVisuals } from '@/server/services/visual-settings';
import { MAIN_MARGINS } from '@/lib/visual-presets';
import { saveMainVisuals } from '@/app/actions/admin/visuals';
import { PageHeader } from '@/components/layout/console-shell';
import { Card, Notice } from '@/components/ui';
import { ImageUploadField } from '@/components/studio/image-upload-field';
import { ActionForm } from '@/components/studio/action-form';

export const dynamic = 'force-dynamic';
export default async function Appearance() {
  const admin = await requireAdmin();
  const v = await getMainVisuals();
  return <><PageHeader title="메인 화면 디자인" description="좌우 균형에 맞춰 제작한 생성형 여백 이미지 5종입니다. 사용할 이미지를 고르거나 각 이미지를 직접 교체하세요." />
    {admin.adminPermission !== 'SUPER_ADMIN' ? <Notice tone="warning">변경은 최고관리자만 가능합니다.</Notice> : null}
    <ActionForm action={saveMainVisuals} submitLabel="메인 이미지 저장" className="space-y-5">
      <Card><p className="mb-4 font-bold">메인에 표시할 이미지</p><div className="grid grid-cols-2 gap-3 lg:grid-cols-5">{v.images.map((url, i) => <label className="overflow-hidden rounded-xl border border-ink-200" key={i}><Image unoptimized src={url} width={300} height={180} alt={`메인 여백 ${i + 1}`} className="aspect-[5/3] w-full object-cover" /><span className="flex items-center gap-2 p-3 text-xs font-bold"><input type="radio" name="activeIndex" value={i} defaultChecked={v.activeIndex === i} />{i + 1}. {MAIN_MARGINS[i].label}</span></label>)}</div><Link href="/" target="_blank" className="mt-4 inline-block text-sm font-bold underline">메인 화면 확인</Link></Card>
      <div className="grid gap-4 lg:grid-cols-2">{v.images.map((url, i) => <Card key={i}><ImageUploadField name={`image${i}`} label={`여백 이미지 ${i + 1} · ${MAIN_MARGINS[i].label}`} defaultValue={url} hint="좌우에 장면이 균형 있게 있고 중앙이 여유로운 가로 이미지를 권장합니다." /><p className="mt-2 text-xs text-ink-500">기본 생성 이미지: {MAIN_MARGINS[i].url}</p></Card>)}</div>
    </ActionForm></>;
}
