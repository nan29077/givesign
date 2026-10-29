import Link from 'next/link';
import { Megaphone, ArrowRight } from 'lucide-react';
import { prisma } from '@/server/db';
import { kstStartOfDay } from '@/lib/datetime';

/**
 * 관리자(/admin/banners)에서 등록한 배너를 노출하는 공용 컴포넌트 (서버).
 * - position: HOME_TOP / HOME_MIDDLE / SUPPORT_TOP / CONSOLE_TOP
 * - active=true 이면서 노출 기간(startsAt~endsAt) 안에 있는 배너만 표시한다.
 * - DB 장애 시에도 화면 전체가 무너지지 않게 조회 실패는 빈 목록으로 처리한다.
 */
export async function BannerStrip({ position, className }: { position: string; className?: string }) {
  const now = new Date();
  // 종료일은 "그날까지" 노출한다.
  // 관리자 폼이 날짜를 KST 00:00 으로 저장하므로 endsAt >= now 로 비교하면
  // 종료일 당일 새벽부터 배너가 사라져 하루가 통째로 빠진다.
  const todayStart = kstStartOfDay(now);
  const banners = await prisma.banner
    .findMany({
      where: {
        position,
        active: true,
        OR: [{ startsAt: null }, { startsAt: { lte: now } }],
        AND: [{ OR: [{ endsAt: null }, { endsAt: { gte: todayStart } }] }],
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      take: 3,
      select: { id: true, title: true, subtitle: true, imageUrl: true, linkUrl: true },
    })
    .catch(() => []);

  if (banners.length === 0) return null;

  // 배경 CSS 로 주입되므로 상대 경로 또는 http(s) URL 만 허용한다.
  const safeImageUrl = (url: string | null) =>
    url && /^(\/|https?:\/\/)[^\s'")]+$/.test(url) ? url : null;

  return (
    <div className={className}>
      <div className="space-y-2">
        {banners.map((b) => {
          const imageUrl = safeImageUrl(b.imageUrl);
          const inner = imageUrl ? (
            <div
              className="relative flex min-h-[76px] items-end overflow-hidden rounded-2xl bg-ink-900 bg-cover bg-center"
              style={{ backgroundImage: `url(${imageUrl})` }}
            >
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(12,10,30,0.05)_0%,rgba(12,10,30,0.72)_100%)]" />
              <div className="relative flex w-full items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-bold text-white">{b.title}</p>
                  {b.subtitle ? <p className="truncate text-[12px] text-white/75">{b.subtitle}</p> : null}
                </div>
                {b.linkUrl ? <ArrowRight size={16} strokeWidth={1.8} className="shrink-0 text-white/80" /> : null}
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3 rounded-2xl border border-brand-100 bg-brand-50 px-4 py-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white text-brand-700">
                  <Megaphone size={16} strokeWidth={1.7} />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-[13.5px] font-bold text-ink-900">{b.title}</p>
                  {b.subtitle ? <p className="truncate text-[12px] text-ink-500">{b.subtitle}</p> : null}
                </div>
              </div>
              {b.linkUrl ? <ArrowRight size={16} strokeWidth={1.8} className="shrink-0 text-brand-700" /> : null}
            </div>
          );

          return b.linkUrl ? (
            <Link key={b.id} href={b.linkUrl} className="block transition-transform hover:-translate-y-0.5">
              {inner}
            </Link>
          ) : (
            <div key={b.id}>{inner}</div>
          );
        })}
      </div>
    </div>
  );
}
