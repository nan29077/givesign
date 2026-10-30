import Link from 'next/link';
import { doneeVerified } from '@/server/services/receipts';
import { ExternalLink } from 'lucide-react';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { getDonationPage } from '@/server/services/fundraising';
import { saveDonationPageAction } from '@/app/actions/fundraising';
import { PageHeader } from '@/components/layout/console-shell';
import { ActionForm } from '@/components/studio/action-form';
import { ImageUploadField } from '@/components/studio/image-upload-field';
import { PresetImagePicker } from '@/components/studio/preset-image-picker';
import { DONATION_BANNERS, DONATION_MARGINS } from '@/lib/visual-presets';
import { Badge, Card, Checkbox, Field, Input, Notice, SectionTitle, Textarea } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * 공개 후원페이지(/donate/[code]) 구성.
 * 결제 흐름 자체는 건드리지 않고 겉모습·공개 항목만 정한다.
 */
export default async function DonationPageSettings() {
  const { merchantId } = await requireMerchant();
  const [page, org] = await Promise.all([
    getDonationPage(merchantId),
    prisma.merchantProfile.findUniqueOrThrow({ where: { id: merchantId }, select: { code: true, fundraisingRegNo: true, designatedDonee: true, designatedDoneeVerifiedAt: true, designatedDoneeUntil: true } }),
  ]);

  return (
    <>
      <PageHeader
        title="후원페이지"
        description="후원자에게 공개되는 기관 페이지를 구성합니다. 공유 주소는 /donate/기관코드 입니다."
        action={
          <Link href={`/donate/${org.code}`} target="_blank" className="inline-flex h-11 items-center gap-1.5 rounded-xl border border-ink-200 bg-white px-4 text-[14px] font-extrabold text-ink-900">
            미리보기 <ExternalLink size={16} strokeWidth={1.7} />
          </Link>
        }
      />

      <ActionForm action={saveDonationPageAction} submitLabel="후원페이지 저장" className="space-y-5">
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[14px] font-extrabold text-ink-900">
                공개 상태 <Badge tone={page.published ? 'success' : 'neutral'}>{page.published ? '공개' : '비공개'}</Badge>
              </p>
              <p className="mt-1 text-[12.5px] text-ink-500">
                공유 주소 <span className="font-mono">/donate/{org.code}</span> · 비공개여도 기관 담당자는 미리 볼 수 있습니다.
              </p>
            </div>
            <Checkbox name="published" defaultChecked={page.published} label="후원페이지 공개" />
          </div>
        </Card>

        <section>
          <SectionTitle title="첫 화면" description="가장 먼저 보이는 제목·소개·이미지입니다." />
          <Card className="space-y-4">
            <Field label="대표 제목" required>
              <Input name="title" defaultValue={page.title} required maxLength={100} />
            </Field>
            <Field label="한 줄 소개">
              <Input name="subtitle" defaultValue={page.subtitle ?? ''} maxLength={300} />
            </Field>
            <PresetImagePicker name="heroUrl" label="대표 배너 · 생성형 이미지 5종" value={page.heroUrl || ''} presets={DONATION_BANNERS} />
            <PresetImagePicker name="backgroundUrl" label="좌우 여백 · 생성형 이미지 5종" value={page.backgroundUrl} presets={DONATION_MARGINS} />
            <ImageUploadField name="logoUrl" label="기관 로고" defaultValue={page.logoUrl ?? ''} aspect="square" hint="공개 후원페이지 왼쪽 상단·기관 소개·오른쪽 메뉴에 표시됩니다. 가로형 로고도 원본 비율로 표시하며, 미등록 시 상단에는 기관명이 표시됩니다." />
            <Field label="기관 대표 색상" hint="진행률 막대와 강조 버튼에 쓰입니다.">
              <Input type="color" name="color" defaultValue={page.color} className="h-11 w-24 p-1" />
            </Field>
          </Card>
        </section>

        <section>
          <SectionTitle title="소개와 감사 인사" />
          <Card className="space-y-4">
            <Field label="기관 소개와 후원 이야기" hint="줄바꿈이 그대로 표시됩니다.">
              <Textarea name="intro" defaultValue={page.intro ?? ''} rows={9} maxLength={10000} />
            </Field>
            <Field label="후원자에게 전하는 감사 인사" hint="후원 완료 화면과 페이지 하단에 표시됩니다.">
              <Textarea name="thanks" defaultValue={page.thanks ?? ''} rows={3} maxLength={1000} />
            </Field>
            <Field label="결산·공시 링크" hint="기관 홈페이지의 결산서·사업보고 주소. 투명성 섹션에 표시됩니다.">
              <Input name="transparencyUrl" defaultValue={page.transparencyUrl ?? ''} placeholder="https://" />
            </Field>
          </Card>
        </section>

        <section>
          <SectionTitle title="공개 항목" description="후원자에게 어떤 정보를 보여 줄지 정합니다." />
          <Card>
            <Checkbox name="showCampaigns" defaultChecked={page.showCampaigns} label="모금 중 캠페인 표시" description="진행률과 함께 보여 줍니다. 꺼도 캠페인 키워드 문자는 정상 처리됩니다." />
            <Checkbox name="showProgress" defaultChecked={page.showProgress} label="모금 현황 표시" description="누적 후원액 · 후원자 수 · 이달 후원액" />
            <Checkbox name="showRecentDonors" defaultChecked={page.showRecentDonors} label="최근 후원 표시" description="이름은 마스킹(홍*동)되고, 익명 후원은 '익명' 으로 표시됩니다. 전화번호는 어떤 경우에도 공개되지 않습니다." />
          </Card>
        </section>
      </ActionForm>

      <div className="mt-5 space-y-3">
        {!org.fundraisingRegNo ? (
          <Notice tone="warning" title="기부금품 모집 등록번호가 비어 있습니다">
            연 1천만원 이상 모집하려면 기부금품법에 따른 모집 등록이 필요하며, 등록번호는 후원페이지 하단에 표기됩니다. <Link href="/studio/profile" className="font-bold underline">기관 정보</Link>에서 입력해 주세요.
          </Notice>
        ) : null}
        {!doneeVerified(org) ? (
          <Notice tone="neutral">
            {org.designatedDonee
              ? '공익법인(지정기부금단체) 지정을 관리자가 아직 확인하지 않았거나 지정 기간이 지났습니다. 확인이 끝나면 후원페이지에 “기부금영수증 발급 가능” 안내가 표시되고 영수증을 발급할 수 있습니다.'
              : null}
            {!org.designatedDonee ? (
              <>
                공익법인(지정기부금단체) 지정이 확인되지 않아 후원페이지에 &ldquo;기부금영수증 발급 가능&rdquo; 안내가 표시되지 않습니다. 지정 단체라면 <Link href="/studio/profile" className="font-bold underline">기관 정보</Link>에서 체크하고 지정서를 고객센터로 보내 주세요.
              </>
            ) : null}
          </Notice>
        ) : null}
      </div>
    </>
  );
}
