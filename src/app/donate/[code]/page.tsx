import { DonationLanding } from '@/components/public/donation-landing';
import type { ResolvingMetadata } from 'next';
import { donationShareMetadata } from '@/server/services/share-metadata';
export async function generateMetadata({ params }: { params: Promise<{ code: string }> }, parent: ResolvingMetadata) { const { code } = await params; return donationShareMetadata(code, undefined, parent); }
export const dynamic = 'force-dynamic';
export default async function Page({ params }: { params: Promise<{ code: string }> }) { const { code } = await params; return <DonationLanding code={code} />; }
