import { DonationLanding } from '@/components/public/donation-landing';
import type { ResolvingMetadata } from 'next';
import { donationShareMetadata } from '@/server/services/share-metadata';
export async function generateMetadata({ params }: { params: Promise<{ code: string; id: string }> }, parent: ResolvingMetadata) { const { code, id } = await params; return donationShareMetadata(code, id, parent); }
export const dynamic = 'force-dynamic';
export default async function Page({ params }: { params: Promise<{ code: string; id: string }> }) { const { code, id } = await params; return <DonationLanding code={code} campaignId={id} />; }
