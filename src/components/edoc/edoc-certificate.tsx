import { ShieldCheck } from 'lucide-react';
import { formatKst } from '@/lib/datetime';
import type { EDocSnapshot } from '@/server/services/edoc';

/**
 * 전자문서 완료본 + 서명 확인서(인쇄용). 기관 콘솔과 서명자 화면이 같이 쓴다.
 * 표시하는 이름·번호는 마스킹 값이다. 입력값은 호출부가 복호화해 넘긴다.
 */
export interface CertificateData {
  orgName: string;
  title: string;
  envelopeId: string;
  snapshot: EDocSnapshot;
  values: Record<string, string>;
  status: string;
  sentAt: Date;
  completedAt: Date | null;
  snapshotHash: string;
  documentHash: string | null;
  lastEventHash: string | null;
  chainOk: boolean;
  signers: Array<{ order: number; roleLabel: string; nameMasked: string; phoneMasked: string; signedAt: Date | null; signIp: string | null; signatureUrl: string | null; otpVerifiedAt: Date | null }>;
  events: Array<{ at: Date; label: string; who: string; ip: string | null }>;
}

export function EDocCertificate({ d }: { d: CertificateData }) {
  return (
    <article className="mx-auto max-w-[780px] rounded-[20px] border border-ink-200 bg-white p-6 text-ink-900 sm:p-9 print:rounded-none print:border-0 print:p-0">
      <header className="border-b border-ink-200 pb-4">
        <p className="text-[12px] font-bold text-ink-400">{d.orgName}</p>
        <h1 className="mt-1 text-[22px] font-black">{d.title}</h1>
        <p className="mt-1 text-[12px] text-ink-500">문서번호 <span className="font-mono">{d.envelopeId}</span> · 발송 {formatKst(d.sentAt, false)}{d.completedAt ? ` · 완료 ${formatKst(d.completedAt, false)}` : ''}</p>
      </header>

      {d.snapshot.body ? <div className="mt-5 whitespace-pre-wrap text-[13.5px] leading-[1.85] text-ink-800">{d.snapshot.body}</div> : null}

      {d.snapshot.fields.length ? (
        <table className="mt-5 w-full border-collapse text-[13px]">
          <tbody>
            {d.snapshot.fields.map((f) => (
              <tr key={f.id} className="border-t border-ink-100">
                <th className="w-[38%] bg-ink-50 px-3 py-2 text-left font-semibold text-ink-600">{f.label}</th>
                <td className="whitespace-pre-wrap px-3 py-2">{f.type === 'CHECKBOX' ? (d.values[f.id] === 'Y' ? '동의함' : '동의하지 않음') : f.type === 'PHONE' ? (d.values[f.id] || '-').replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3') : d.values[f.id] || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      <section className="mt-6 grid gap-3 sm:grid-cols-2">
        {d.signers.map((s) => (
          <div key={s.order} className="rounded-xl border border-ink-200 p-3">
            <p className="text-[12px] font-bold text-ink-500">{s.order}. {s.roleLabel}</p>
            <p className="text-[14px] font-black">{s.nameMasked} <span className="font-mono text-[11.5px] font-semibold text-ink-400">{s.phoneMasked}</span></p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {s.signatureUrl ? <img src={s.signatureUrl} alt="서명" className="mt-2 h-20 w-full object-contain" /> : <p className="mt-2 h-20 text-[12px] text-ink-300">서명 전</p>}
            <p className="mt-1 text-[11px] text-ink-500">
              {s.signedAt ? `서명 ${formatKst(s.signedAt)}` : '-'}
              {s.otpVerifiedAt ? ' · 문자 본인확인' : ''}
              {s.signIp ? ` · ${s.signIp}` : ''}
            </p>
          </div>
        ))}
      </section>

      <section className="mt-7 break-inside-avoid rounded-xl bg-ink-50 p-4">
        <h2 className="flex items-center gap-1.5 text-[13.5px] font-black"><ShieldCheck size={16} strokeWidth={1.7} /> 서명 확인서</h2>
        <dl className="mt-2 space-y-1 text-[11px]">
          <div><dt className="inline font-bold text-ink-600">서식 해시 </dt><dd className="inline break-all font-mono text-ink-500">{d.snapshotHash}</dd></div>
          {d.documentHash ? <div><dt className="inline font-bold text-ink-600">완료본 해시 </dt><dd className="inline break-all font-mono text-ink-500">{d.documentHash}</dd></div> : null}
          {d.lastEventHash ? <div><dt className="inline font-bold text-ink-600">감사추적 끝값 </dt><dd className="inline break-all font-mono text-ink-500">{d.lastEventHash}</dd></div> : null}
          <div><dt className="inline font-bold text-ink-600">해시 연결 </dt><dd className="inline">{d.chainOk ? '정상' : '불일치 — 기관에 문의하세요'}</dd></div>
        </dl>
        <ol className="mt-3 space-y-0.5 text-[11px] text-ink-600">
          {d.events.map((e, i) => (
            <li key={i} className="tabular-nums">{formatKst(e.at)} · {e.label}{e.who ? ` · ${e.who}` : ''}{e.ip ? ` · ${e.ip}` : ''}</li>
          ))}
        </ol>
        <p className="mt-3 text-[10.5px] leading-relaxed text-ink-400">
          이 확인서는 기브싸인이 남긴 내부 감사기록(문자 본인확인·접속 정보·해시 연결)을 정리한 것입니다. 공동인증서 전자서명, 공인전자문서중계자 보관, 시점확인(TSA)은 적용되지 않았습니다.
        </p>
      </section>
    </article>
  );
}
