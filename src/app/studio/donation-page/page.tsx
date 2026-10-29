import Link from 'next/link';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { getDonationPage } from '@/server/services/fundraising';
import { saveDonationPage } from '@/app/actions/fundraising';
import { PageHeader } from '@/components/layout/console-shell';
import { ImageUploadField } from '@/components/studio/image-upload-field';
import { Button, Card, Field, Input, Textarea, Notice } from '@/components/ui';

export default async function DonationPageSettings({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string }> }) {
  const { merchantId } = await requireMerchant();
  const [c, org, sp] = await Promise.all([getDonationPage(merchantId), prisma.merchantProfile.findUniqueOrThrow({ where: { id: merchantId } }), searchParams]);
  return <><PageHeader title="기관 후원페이지 설정" description="기관 소개와 대표 이미지, 감사 인사를 구성하고 후원페이지를 공개하세요." />
    {sp.saved && <Notice tone="brand">저장되었습니다.</Notice>}{sp.error && <Notice tone="danger">{sp.error}</Notice>}
    <form action={saveDonationPage} className="space-y-5">
      <Card><div className="flex flex-wrap justify-between gap-3"><label><input type="checkbox" name="published" defaultChecked={c.published} /> 후원페이지 공개</label><Link href={`/donate/${org.code}`} target="_blank" className="font-bold text-brand-700">후원페이지 미리보기 ↗</Link></div><p className="mt-2 text-sm text-ink-500">공유 주소: /donate/{org.code} · 비공개 페이지는 기관 담당자만 미리 볼 수 있습니다.</p></Card>
      <Card className="space-y-4"><Field label="대표 제목" required><Input name="title" defaultValue={c.title} required maxLength={100} /></Field><Field label="한 줄 소개"><Input name="subtitle" defaultValue={c.subtitle} maxLength={300} /></Field><ImageUploadField name="hero" label="대표 배너" defaultValue={c.hero} /><ImageUploadField name="logo" label="기관 로고" defaultValue={c.logo} aspect="square" /><Field label="기관 대표 색상"><Input type="color" name="color" defaultValue={c.color} /></Field></Card>
      <Card className="space-y-4"><Field label="기관 소개와 후원 이야기"><Textarea name="intro" defaultValue={c.intro} rows={9} maxLength={10000} /></Field><Field label="후원자에게 전하는 감사 인사"><Textarea name="thanks" defaultValue={c.thanks} rows={3} maxLength={1000} /></Field><label><input type="checkbox" name="showCampaigns" defaultChecked={c.showCampaigns} /> 공개 캠페인 표시</label></Card><Button type="submit">후원페이지 저장</Button>
    </form></>;
}
