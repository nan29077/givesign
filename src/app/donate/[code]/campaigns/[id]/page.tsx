import { DonationLanding } from '@/components/public/donation-landing';
export const dynamic = 'force-dynamic';
export default async function Page({ params }: { params: Promise<{ code: string; id: string }> }) { const { code, id } = await params; return <DonationLanding code={code} campaignId={id} />; }
