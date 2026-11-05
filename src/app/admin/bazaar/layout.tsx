import { bazaarPageGuard } from '@/server/services/bazaar-settings';

export const dynamic = 'force-dynamic';

/** 라이브 바자회(관리자): 스위치가 꺼지면 하위 경로 전체 404. 정산 지급은 /admin/in-kind-settlements 에서 계속한다. */
export default async function AdminBazaarLayout({ children }: { children: React.ReactNode }) {
  await bazaarPageGuard();
  return <>{children}</>;
}
