import { HandHeart } from 'lucide-react';
import { formatKst } from '@/lib/datetime';
import { donorImpactEntries } from '@/server/services/impact-reports';

/**
 * 후원자 화면 "내가 함께한 사업" (2026-11-09 3차 H1) — 참여한 캠페인의 승인·발송된 진행 기록과 결과 보고.
 * 결과는 캠페인 전체 결과이고, 본인 기록은 후원 횟수·합계만 따로 보인다(개인별 사용처 없음). 본문 16px 이상.
 */
export async function DonorImpactList({ payerId, merchantId, color }: { payerId: string; merchantId?: string; color?: string }) {
  const entries = await donorImpactEntries(payerId, { merchantId, take: 10 }).catch(() => []);
  return (
    <section className="rounded-[24px] border border-ink-100 bg-white p-5">
      <h2 className="flex items-center gap-2 text-[18px] font-black text-ink-900"><HandHeart size={20} strokeWidth={1.7} style={color ? { color } : undefined} /> 내가 함께한 사업</h2>
      {entries.length === 0 ? (
        <p className="mt-2 text-[16px] text-ink-500">함께한 캠페인의 진행 소식이 올라오면 여기에 보입니다.</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {entries.map((e) => (
            <li key={e.id} className="rounded-2xl bg-ink-50 p-4">
              <p className="text-[13px] font-bold text-ink-500">{merchantId ? '' : `${e.merchantName} · `}{e.campaignTitle} · {formatKst(e.at, false)}</p>
              <p className="mt-0.5 text-[17px] font-black text-ink-900">{e.title}</p>
              <p className="mt-1 text-[16px] font-semibold" style={color ? { color } : undefined}>{e.participation}</p>
              <details className="mt-2">
                <summary className="cursor-pointer text-[16px] font-bold text-ink-700">사업 결과 보기(캠페인 전체)</summary>
                <p className="mt-2 whitespace-pre-wrap text-[16px] leading-relaxed text-ink-800">{e.report}</p>
                {e.photos.length ? (
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    {e.photos.map((p) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={p} src={p} alt="사업 진행 사진" className="aspect-square w-full rounded-xl object-cover" />
                    ))}
                  </div>
                ) : null}
                <p className="mt-2 text-[14px] text-ink-400">캠페인 전체의 결과이며, 한 분의 후원금이 특정 항목에 쓰였다는 뜻은 아닙니다.</p>
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
