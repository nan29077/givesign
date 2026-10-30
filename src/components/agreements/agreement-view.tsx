import { Badge } from '@/components/ui';
import { formatKst } from '@/lib/datetime';
import { dayLabel, slotLabel, verifyAgreement } from '@/server/services/agreements';
import type { AgreementDocument } from '@/generated/prisma/client';

/**
 * 전자 약정서·신청서 열람 서식 (인쇄 가능).
 * 발급 당시 스냅샷만 그린다 — 이후 기관 정보·약정이 바뀌어도 이 문서는 변하지 않는다.
 * 개인정보는 스냅샷에 든 마스킹 값만 쓴다.
 */

type Snap = {
  kind: string;
  issuer: { name: string; code: string; businessNo: string | null; representative: string | null; address: string | null; contact: string | null; fundraisingRegNo: string | null };
  donor?: { name: string; phoneMasked: string };
  applicant?: { name: string; phoneMasked: string };
  pledge?: { amountText: string; dayOfMonth: number; cycle: string; firstChargeOn: string; campaign: string; anonymous: boolean; message: string; method: string };
  application?: { wish: string | null; interests: string[]; availableDays: string[]; timeSlot: string | null; experience: string | null; emergency: string | null; safetyPledged: boolean; message: string | null };
  consent: { termsTitle: string; termsVersion: string | null; termsHash: string | null };
};

const ESIGN_LABEL: Record<string, { text: string; tone: 'neutral' | 'brand' | 'success' | 'danger' | 'warning' }> = {
  NONE: { text: '동의 기록으로 성립', tone: 'neutral' },
  REQUESTED: { text: '전자서명 요청됨', tone: 'warning' },
  SIGNED: { text: '전자서명 완료', tone: 'success' },
  DECLINED: { text: '서명 거절', tone: 'danger' },
  EXPIRED: { text: '서명 기한 만료', tone: 'neutral' },
};

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3 border-b border-ink-100 py-2.5 text-[13.5px] last:border-0">
      <dt className="text-ink-400">{k}</dt>
      <dd className="font-semibold text-ink-900">{v}</dd>
    </div>
  );
}

export function AgreementView({ doc }: { doc: AgreementDocument }) {
  const s = doc.snapshot as unknown as Snap;
  const ok = verifyAgreement(doc);
  const es = ESIGN_LABEL[doc.esignStatus] ?? ESIGN_LABEL.NONE!;
  return (
    <article className="card mx-auto max-w-[720px] p-6 print:shadow-none sm:p-8">
      <header className="border-b-2 border-ink-900 pb-4">
        <p className="text-[12px] font-bold tracking-widest text-ink-400">{doc.docNo} · 제{doc.version}판</p>
        <h1 className="mt-1 text-[24px] font-black text-ink-900">{s.issuer.name} {doc.title}</h1>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Badge tone={es.tone}>{es.text}</Badge>
          <Badge tone={ok ? 'success' : 'danger'}>{ok ? '내용 무결성 확인' : '내용 불일치 — 위변조 의심'}</Badge>
          {doc.supersedesId ? <Badge>이전 판 대체</Badge> : null}
        </div>
      </header>

      {s.pledge && s.donor ? (
        <section className="mt-5">
          <h2 className="mb-1 text-[14px] font-black text-ink-700">약정 내용</h2>
          <dl>
            <Row k="후원자" v={<>{s.donor.name} <span className="font-mono text-ink-500">{s.donor.phoneMasked}</span></>} />
            <Row k="약정 금액" v={`${s.pledge.cycle} ${s.pledge.dayOfMonth}일 ${s.pledge.amountText}`} />
            <Row k="출금 방법" v={s.pledge.method} />
            <Row k="첫 출금 예정일" v={s.pledge.firstChargeOn} />
            <Row k="지정" v={s.pledge.campaign} />
            <Row k="공개 표시" v={s.pledge.anonymous ? '익명' : '이름 공개'} />
          </dl>
        </section>
      ) : null}

      {s.application && s.applicant ? (
        <section className="mt-5">
          <h2 className="mb-1 text-[14px] font-black text-ink-700">신청 내용</h2>
          <dl>
            <Row k="신청자" v={<>{s.applicant.name} <span className="font-mono text-ink-500">{s.applicant.phoneMasked}</span></>} />
            <Row k="활동 분야" v={s.application.interests.join(', ') || '-'} />
            <Row k="가능 요일" v={`${s.application.availableDays.map(dayLabel).join(', ') || '-'} · ${slotLabel(s.application.timeSlot)}`} />
            <Row k="희망 활동" v={s.application.wish ?? '-'} />
            <Row k="경력" v={s.application.experience ?? '-'} />
            <Row k="비상연락처" v={s.application.emergency ?? '-'} />
            <Row k="안전 수칙 서약" v={s.application.safetyPledged ? '서약함' : '-'} />
          </dl>
        </section>
      ) : null}

      <section className="mt-5">
        <h2 className="mb-1 text-[14px] font-black text-ink-700">동의 기록</h2>
        <dl>
          <Row k="동의 항목" v={`${s.consent.termsTitle}${s.consent.termsVersion ? ` (${s.consent.termsVersion})` : ''}`} />
          <Row k="동의 시각" v={formatKst(doc.consentAt)} />
          <Row k="접속 정보" v={doc.consentIp ? `IP ${doc.consentIp}` : '-'} />
          {doc.signedAt ? <Row k="서명 시각" v={`${formatKst(doc.signedAt)} (${doc.esignProvider ?? ''})`} /> : null}
          <Row k="문서 해시" v={<span className="break-all font-mono text-[11.5px] font-normal">{doc.contentHash}</span>} />
        </dl>
      </section>

      <footer className="mt-6 rounded-xl bg-ink-50 p-4 text-[12.5px] leading-relaxed text-ink-600">
        <p className="font-bold text-ink-800">약정 주체 (기관)</p>
        <p>{s.issuer.name} · 고유번호 {s.issuer.businessNo ?? '-'} · 대표 {s.issuer.representative ?? '-'}</p>
        <p>{s.issuer.address ?? ''}</p>
        {s.issuer.contact ? <p>문의 {s.issuer.contact}</p> : null}
        {s.issuer.fundraisingRegNo ? <p>기부금품 모집등록 {s.issuer.fundraisingRegNo}</p> : null}
        <p className="mt-2 text-ink-400">이 문서는 기브싸인이 동의 시점의 내용을 고정해 만든 기록입니다. 공인전자문서 중계·시점확인(TSA)은 연결되어 있지 않습니다.</p>
      </footer>
    </article>
  );
}
