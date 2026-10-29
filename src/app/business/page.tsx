import type { Metadata } from 'next';
import { PublicShell } from '@/components/layout/public-shell';
import { PageHeader } from '@/components/public/page-header';
import { Card, LinkButton } from '@/components/ui';
import { SupportForm } from '@/components/public/support-form';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: '기관 도입 안내',
  description: '사회복지기관 전용 MO 번호와 후원페이지, 캠페인·정기후원·기부금영수증 운영 환경을 도입하는 절차를 안내합니다.',
};
export default function Business(){return <PublicShell><PageHeader eyebrow="기관 도입 안내" title="기관의 나눔에, 더 쉬운 참여를" description="사회복지기관 전용 MO 번호와 기관 후원페이지로 후원자를 만나세요." /><Card><h2 className="text-xl font-bold">복지 현장에 맞춘 후원 운영</h2><p className="mt-4 leading-8">종합사회복지관, 아동·청소년 기관, 장애인·노인복지기관과 비영리단체가 기관 소개와 후원 캠페인을 운영할 수 있습니다.</p><ol className="mt-5 space-y-4"><li>1. 기관 정보와 운영 계획을 제출합니다.</li><li>2. 기관 심사와 MO 번호 배정을 진행합니다.</li><li>3. 후원페이지와 캠페인, 후원 안내 문자를 설정합니다.</li><li>4. 문자 접수와 결제·정산 흐름을 검수한 뒤 운영합니다.</li></ol><p className="mt-5 text-sm leading-7">실제 MO 개통과 결제 연동은 별도 계약 및 설정이 필요합니다. 제공 범위와 비용은 도입 상담에서 확인해 주세요.</p><div className="mt-5"><LinkButton href="/merchant-apply">기관 도입 신청</LinkButton></div></Card><div className="mt-6"><SupportForm mode="onboarding" /></div></PublicShell>}
