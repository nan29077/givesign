import Link from 'next/link';
import { Check, Clock3 } from 'lucide-react';

/**
 * 홈 — 기브싸인 자동화 소개.
 *
 * 가운데 한 가지가 기억에 남게 한다: 한 후원자가 SNS 게시물을 보고 한 달 동안 받는 실제 메시지 흐름.
 * 말풍선 옆 메모는 그때 기브싸인이 기관 대신 한 일이다. 나머지 섹션은 조용하게 둔다.
 * 아직 외부 심사 중인 연동은 '심사 후 열림' 으로 솔직하게 표시한다(절대 규칙 2 — 준비 안 된 기능을 된다고 쓰지 않는다).
 */

type Bubble = { side: 'out' | 'in'; from?: string; text: string; link?: string };
type Moment = { date: string; bubbles: Bubble[]; note: string };

const THREAD: Moment[] = [
  {
    date: '10월 3일 저녁',
    bubbles: [{ side: 'in', from: '인스타그램 릴스', text: '올겨울 홀몸 어르신 300가구에 김장김치를 전합니다. 기관 번호로 ‘김장’ 을 보내 함께해 주세요.' }],
    note: '캠페인 이야기로 숏폼과 이미지를 만들고, 담당자가 승인하자 기관 계정에 올렸습니다.',
  },
  {
    date: '10월 3일 저녁',
    bubbles: [
      { side: 'out', text: '김장 응원합니다' },
      { side: 'in', from: '햇살종합사회복지관', text: '후원 금액을 골라 주세요. 김장 나눔 캠페인으로 접수됩니다.', link: '금액 선택' },
    ],
    note: '키워드로 캠페인을 찾아 지정후원으로 잡고, 이 후원이 어떤 게시물에서 왔는지 기록했습니다.',
  },
  {
    date: '10월 5일',
    bubbles: [
      { side: 'out', text: '정기' },
      { side: 'in', from: '햇살종합사회복지관', text: '정기후원 약정 안내입니다. 금액과 출금일을 정해 약정서를 작성해 주세요.', link: '약정서 작성' },
      { side: 'in', from: '알림톡', text: '정기후원 약정서가 작성되었습니다. 매월 25일 20,000원. 보관용 열람', link: '약정서 보기' },
    ],
    note: '약정 내용을 그 순간 그대로 문서로 고정하고, 후원자와 기관 양쪽에 보관본을 남겼습니다.',
  },
  {
    date: '10월 25일',
    bubbles: [{ side: 'in', from: '알림톡', text: '정기후원 20,000원이 출금되었습니다. 늘 함께해 주셔서 감사합니다.' }],
    note: '매일 아침 배치가 출금일이 된 약정을 한 달에 한 번만 결제했습니다.',
  },
  {
    date: '11월 1일',
    bubbles: [
      { side: 'in', from: '알림톡', text: '10월 후원 안내. 2회 30,000원, 올해 누적 30,000원 후원해 주셨습니다. 내역과 영수증', link: '열어 보기' },
      { side: 'out', text: '봉사' },
      { side: 'in', from: '햇살종합사회복지관', text: '자원봉사 신청 안내입니다. 활동 분야와 가능한 시간을 적어 주세요.', link: '신청서' },
    ],
    note: '지난달 후원자 모두에게 월간 안내를 보냈습니다. 같은 사람이 봉사자로도 이어졌습니다.',
  },
  {
    date: '1월 15일',
    bubbles: [{ side: 'in', from: '알림톡', text: '2026년 기부금영수증(260,000원)이 발급되었습니다. 열람·출력', link: '영수증' }],
    note: '한 해 후원을 합산해 영수증을 발급하고, 홈택스 제출 파일까지 만들었습니다.',
  },
];

const SPLIT: Array<{ org: string; us: string }> = [
  { org: '캠페인 이야기와 목표를 적습니다', us: '숏폼 대본·장면·캡션을 만들고, AI 생성 표시와 모집등록번호를 넣습니다' },
  { org: '게시물을 보고 승인합니다', us: '예약 시각에 유튜브·인스타그램·페이스북에 올리고 유입을 셉니다' },
  { org: '문자 번호 하나를 알립니다', us: '‘정기’ 는 약정서로, ‘봉사’ 는 신청서로, 나머지는 후원으로 받습니다' },
  { org: '봉사 신청을 승인하고 일정을 적습니다', us: '배정 안내를 보내고 활동 시간을 1365 등록 자료로 정리합니다' },
  { org: '한 달에 한 번 현황을 봅니다', us: '출금·안내·영수증을 알림톡으로 보내고, 실패하면 문자로 다시 보냅니다' },
];

const LIVE = ['문자 후원·정기 약정·봉사 신청 접수', '전자 약정서 보관과 내용 검증', '후원자·봉사자 통합 관리와 명단 업로드', '콘텐츠 자동 생성과 승인·내려받기', '월간 안내와 기부금영수증 발급'];
const PENDING = ['카카오 알림톡 발송 (기관별 채널 승인)', 'SNS 자동 게시 (유튜브·메타 앱 심사)', '전자서명 연동 (페이싸인 등)', '카드 결제와 무PIN 정기 출금 (금융사 승인)'];

const SAFEGUARDS = [
  { t: '기관 명의 게시물은 승인 후에만', d: '자동으로 만들되 올리는 건 담당자가 확인한 뒤입니다. 모집등록번호가 없으면 승인되지 않습니다.' },
  { t: '광고 문자는 보내지 않습니다', d: '알림톡은 출금·영수증·약정서처럼 후원자 본인의 일만 알립니다. 모르는 사람에게 먼저 연락하지 않습니다.' },
  { t: '한 달에 한 번만 출금', d: '같은 약정이 같은 달에 두 번 결제되지 않게 막고, 결과를 모르면 확인될 때까지 멈춥니다.' },
  { t: '개인정보는 가려서', d: '전화번호·주민번호는 암호화해 두고 기관 화면에는 가린 번호만 보입니다.' },
];

export function HomeAutomation() {
  return (
    <>
      <style>{`
        @keyframes gs-rise { from { opacity: 0; transform: translateY(10px) } to { opacity: 1; transform: none } }
        .gs-moment { animation: gs-rise .5s cubic-bezier(.2,.7,.2,1) both }
        @media (prefers-reduced-motion: reduce) { .gs-moment { animation: none } }
      `}</style>

      <section id="donation-automation" className="mt-10 scroll-mt-24" aria-labelledby="home-auto-title">
        <h2 id="home-auto-title" className="text-[30px] font-black leading-[1.22] tracking-[-0.04em] text-ink-900 sm:text-[36px]">
          게시물 하나가<br />한 해의 후원이 되기까지
        </h2>
        <p className="mt-4 max-w-[34em] text-[15px] leading-[1.85] text-ink-500">
          기관은 캠페인 이야기를 적고 승인만 합니다. 알리고, 받고, 약정서를 남기고, 매달 감사를 전하고, 연말에 영수증을 보내는 일은 기브싸인이 이어서 합니다. 한 후원자가 받는 한 달을 그대로 옮겼습니다.
        </p>

        <div className="mt-8 rounded-[28px] bg-[#e9efe4] p-3 sm:p-5">
          <ol className="space-y-6">
            {THREAD.map((m, i) => (
              <li key={i} className="gs-moment grid gap-3 sm:grid-cols-[1fr_200px] sm:gap-5" style={{ animationDelay: `${i * 90}ms` }}>
                <div>
                  <p className="mb-2 pl-1 text-[12px] font-bold text-brand-700">{m.date}</p>
                  <div className="space-y-2">
                    {m.bubbles.map((b, k) =>
                      b.side === 'out' ? (
                        <div key={k} className="flex justify-end">
                          <p className="max-w-[78%] rounded-[20px] rounded-br-md bg-[#d3f291] px-4 py-2.5 text-[14.5px] font-bold text-ink-900">{b.text}</p>
                        </div>
                      ) : (
                        <div key={k} className="max-w-[88%] rounded-[20px] rounded-bl-md bg-white px-4 py-3 shadow-[0_1px_0_rgba(32,60,50,0.08)]">
                          {b.from ? <p className="mb-1 text-[11.5px] font-bold text-ink-400">{b.from}</p> : null}
                          <p className="text-[14px] leading-[1.6] text-ink-900">{b.text}</p>
                          {b.link ? <span className="mt-2 inline-block rounded-full bg-brand-50 px-3 py-1 text-[12.5px] font-bold text-brand-700">{b.link}</span> : null}
                        </div>
                      ),
                    )}
                  </div>
                </div>
                <p className="self-end border-l-2 border-brand-600 pl-3 text-[12.5px] leading-[1.7] text-ink-700 sm:mb-1">{m.note}</p>
              </li>
            ))}
          </ol>
        </div>
        <p className="mt-3 text-[12px] leading-relaxed text-ink-400">예시 흐름입니다. 알림톡을 쓸 수 없는 기관이나 상황에서는 같은 내용이 문자로 갑니다.</p>
      </section>

      <section className="mt-14">
        <h2 className="text-[24px] font-black tracking-[-0.03em] text-ink-900">기관은 결정하고, 나머지는 이어서</h2>
        <div className="mt-6 overflow-hidden rounded-3xl border border-ink-100 bg-white">
          <div className="grid grid-cols-2 border-b border-ink-100 bg-ink-50 text-[13px] font-black">
            <p className="px-4 py-3 text-ink-700">기관이 하는 일</p>
            <p className="border-l border-ink-100 px-4 py-3 text-brand-700">기브싸인이 하는 일</p>
          </div>
          {SPLIT.map((r) => (
            <div key={r.org} className="grid grid-cols-2 border-b border-ink-100 last:border-0">
              <p className="px-4 py-4 text-[13.5px] font-bold leading-[1.6] text-ink-900">{r.org}</p>
              <p className="border-l border-ink-100 px-4 py-4 text-[13.5px] leading-[1.6] text-ink-700">{r.us}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-14">
        <h2 className="text-[24px] font-black tracking-[-0.03em] text-ink-900">후원자와 봉사자를 한 사람으로</h2>
        <p className="mt-3 max-w-[34em] text-[14.5px] leading-[1.85] text-ink-500">
          두 번 후원했는데 정기 약정이 없는 분, 봉사만 하는 분, 반년째 소식이 없는 분. 후원 기록과 약정, 봉사 시간, 기관이 가진 명단을 한 줄로 모아 다음에 누구에게 무엇을 하면 좋을지 보여 줍니다.
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          {['정기 전환 대상', '봉사만 참여', '6개월 휴면', '정기후원 중', '명단만 있음'].map((s) => (
            <span key={s} className="rounded-full border border-ink-200 bg-white px-3.5 py-1.5 text-[13px] font-bold text-ink-700">{s}</span>
          ))}
        </div>
      </section>

      <section className="mt-14">
        <h2 className="text-[24px] font-black tracking-[-0.03em] text-ink-900">자동으로 하되, 넘지 않는 선</h2>
        <dl className="mt-5 space-y-5">
          {SAFEGUARDS.map((s) => (
            <div key={s.t} className="border-l-2 border-ink-200 pl-4">
              <dt className="text-[15px] font-black text-ink-900">{s.t}</dt>
              <dd className="mt-1 text-[13.5px] leading-[1.75] text-ink-500">{s.d}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mt-14 grid gap-3 sm:grid-cols-2">
        <div className="rounded-3xl bg-brand-700 p-5 text-white">
          <h3 className="text-[16px] font-black">지금 바로 쓸 수 있어요</h3>
          <ul className="mt-3 space-y-2">
            {LIVE.map((x) => (
              <li key={x} className="flex gap-2 text-[13.5px] leading-[1.6]"><Check size={18} strokeWidth={1.7} className="mt-0.5 shrink-0 text-[#d3f291]" />{x}</li>
            ))}
          </ul>
        </div>
        <div className="rounded-3xl border border-ink-200 bg-white p-5">
          <h3 className="text-[16px] font-black text-ink-900">심사가 끝나는 대로 열려요</h3>
          <ul className="mt-3 space-y-2">
            {PENDING.map((x) => (
              <li key={x} className="flex gap-2 text-[13.5px] leading-[1.6] text-ink-700"><Clock3 size={18} strokeWidth={1.7} className="mt-0.5 shrink-0 text-ink-400" />{x}</li>
            ))}
          </ul>
          <p className="mt-3 text-[12px] leading-relaxed text-ink-400">열리기 전에는 문자로 보내거나, 만든 콘텐츠를 내려받아 직접 올리는 방식으로 같은 일을 합니다.</p>
        </div>
      </section>

      <div className="mt-8 flex flex-wrap gap-2">
        <Link href="/merchant-apply" className="inline-flex h-12 items-center rounded-2xl bg-ink-900 px-5 text-[14px] font-extrabold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600">기관 도입 신청</Link>
        <Link href="/business" className="inline-flex h-12 items-center rounded-2xl border border-ink-200 bg-white px-5 text-[14px] font-extrabold text-ink-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600">도입 안내 보기</Link>
      </div>
    </>
  );
}
