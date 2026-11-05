import { bazaarPageGuard } from '@/server/services/bazaar-settings';

export const dynamic = 'force-dynamic';

/** 라이브 바자회(기관): 스위치가 꺼지면 하위 경로 전체 404 */
export default async function StudioBazaarLayout({ children }: { children: React.ReactNode }) {
  await bazaarPageGuard();
  return <>{children}</>;
}
