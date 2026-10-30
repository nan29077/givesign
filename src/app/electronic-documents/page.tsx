import { PublicShell } from '@/components/layout/public-shell';
import { PageHeader } from '@/components/public/page-header';
import { EDocumentIntro } from '@/components/public/e-document-intro';
export const dynamic = 'force-dynamic';
export const metadata = { title: '사회복지기관 전자문서', description: '후원약정서, 자원봉사 신청서, 기부금영수증을 위한 기관 전자문서. 충전형과 정액형 이용을 지원합니다.' };
export default function Page() { return <PublicShell><PageHeader eyebrow="기관 전자문서" title="나눔의 현장에 필요한 서류를 더 간편하게" description="기관 서식 작성·요청·서명·확인·보관을 한 흐름으로 연결합니다." /><EDocumentIntro detailed /></PublicShell>; }
