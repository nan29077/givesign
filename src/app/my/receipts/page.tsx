import Link from 'next/link';
import { requirePayerContext, NO_PAYER_TITLE, NO_PAYER_DESC } from '@/components/my/payer';
import { Badge, Card, Checkbox, EmptyState, Field, Input, LinkButton, Notice } from '@/components/ui';
import { DonorActionForm } from '@/components/my/donor-action-form';
import { deleteReceiptProfileAction, openReceiptAction, saveReceiptProfileAction } from '@/app/actions/donor';
import { getReceiptProfile, payerReceiptOverview, receiptStatusLabel } from '@/server/services/receipts';
import { currentTermsDoc } from '@/server/services/terms';
import { formatKst } from '@/lib/datetime';
import { formatWon } from '@/lib/money';

export const dynamic = 'force-dynamic';

/**
 * 내 기부금영수증.
 *  1) 영수증 정보(성명·주민등록번호) 등록 — 동의 기반, 암호화 저장
 *  2) 연도별 발급 현황 · 발급 대기(기관이 발급하면 문자로 안내)
 *  3) 발급된 영수증 열람·출력
 */
export default async function MyReceiptsPage({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const { payerId } = await requirePayerContext('/my/receipts');
  if (!payerId) {
    return (
      <>
        <EmptyState title={NO_PAYER_TITLE} description={NO_PAYER_DESC} />
        <div className="mt-4"><LinkButton href="/my/account#phone-link" size="md" className="w-full">휴대폰 번호 연결하기</LinkButton></div>
      </>
    );
  }
  const sp = await searchParams;
  const nowYear = new Date().getFullYear();
  const years = [nowYear, nowYear - 1, nowYear - 2];
  const year = years.includes(Number(sp.year)) ? Number(sp.year) : nowYear;
  const [profile, overview, terms] = await Promise.all([getReceiptProfile(payerId), payerReceiptOverview(payerId, year), currentTermsDoc('RECEIPT_ISSUANCE')]);

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[16px] font-extrabold text-ink-900">영수증 발급 정보</h2>
          {profile ? <Badge tone="success">등록됨 · {formatKst(profile.updatedAt, false)}</Badge> : <Badge tone="warning">미등록</Badge>}
        </div>
        <p className="mt-1 text-[13px] text-ink-500">
          연말정산용 기부금영수증에는 성명과 주민등록번호가 필요합니다. 주민등록번호는 암호화해 저장하고 영수증 발급·국세청 제출 자료 생성에만 사용합니다.
        </p>
        {profile ? (
          <div className="mt-3 rounded-xl bg-ink-50 p-3 text-[13px]">
            <p><span className="text-ink-400">성명</span> <strong>{profile.legalName}</strong> · <span className="text-ink-400">주민등록번호</span> <span className="font-mono">{profile.residentNoMasked}</span></p>
            <p className="mt-1"><span className="text-ink-400">주소</span> {profile.address || '-'} · <span className="text-ink-400">연말정산 간소화 제출</span> {profile.hometaxOptIn ? '동의' : '종이 영수증만'}</p>
          </div>
        ) : null}
        <details className="mt-3" open={!profile}>
          <summary className="cursor-pointer text-[13px] font-bold text-brand-700">{profile ? '정보 수정' : '정보 등록하기'}</summary>
          <DonorActionForm action={saveReceiptProfileAction} submitLabel={profile ? '수정 저장' : '동의하고 등록'} className="mt-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="성명(실명)" required><Input name="legalName" maxLength={30} defaultValue={profile?.legalName ?? ''} required /></Field>
              <Field label="주민등록번호" required hint="앞 6자리 - 뒤 7자리. 저장 후에는 마스킹으로만 표시됩니다.">
                <div className="flex items-center gap-2">
                  <Input name="residentFront" inputMode="numeric" maxLength={6} pattern="\d{6}" placeholder="900101" required className="font-mono" />
                  <span className="text-ink-400">-</span>
                  <Input name="residentBack" type="password" inputMode="numeric" maxLength={7} pattern="\d{7}" placeholder="●●●●●●●" required className="font-mono" />
                </div>
              </Field>
            </div>
            <Field label="주소(선택)" hint="영수증에 인쇄됩니다."><Input name="address" maxLength={200} defaultValue={profile?.address ?? ''} /></Field>
            <Checkbox name="hometaxOptIn" defaultChecked={profile?.hometaxOptIn ?? false} label="국세청 연말정산 간소화 자료 제출에 동의" description="끄면 종이(화면) 영수증만 발급되고 홈택스에 자동 반영되지 않습니다." />
            <div className="rounded-xl border border-ink-200 p-3">
              <p className="text-[13px] font-bold text-ink-900">{terms?.title ?? '기부금영수증 발급을 위한 개인정보 수집·이용 동의'}</p>
              <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap text-[12px] leading-relaxed text-ink-500">{terms?.content ?? '동의 약관이 준비되지 않았습니다.'}</pre>
              <Checkbox name="agree" required label="위 내용을 확인했고 동의합니다" />
            </div>
          </DonorActionForm>
        </details>
        {profile ? (
          <div className="mt-3 border-t border-ink-100 pt-3">
            <DonorActionForm action={deleteReceiptProfileAction} submitLabel="정보 삭제 · 동의 철회" variant="ghost" size="sm" confirmMessage="영수증 정보를 삭제하고 동의를 철회할까요? 이후 새 영수증은 발급되지 않습니다." />
          </div>
        ) : null}
      </Card>

      <Card>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-[16px] font-extrabold text-ink-900">발급 현황</h2>
          <div className="flex gap-1 rounded-xl bg-ink-100 p-1 text-[12.5px] font-bold">
            {years.map((y) => (
              <Link key={y} href={`/my/receipts?year=${y}`} className={y === year ? 'rounded-lg bg-white px-3 py-1 text-ink-900 shadow-sm' : 'px-3 py-1 text-ink-500'}>{y}년</Link>
            ))}
          </div>
        </div>
        {overview.pending.length ? (
          <div className="mb-3 space-y-2">
            <p className="text-[12px] font-bold text-ink-400">발급 대기(기관이 발급하면 문자로 안내합니다)</p>
            {overview.pending.map((p) => (
              <div key={p.merchantId} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-ink-50 px-3 py-2 text-[13px]">
                <span className="font-semibold text-ink-900">{p.merchantName}</span>
                <span className="tabular-nums">{formatWon(p.amount)} · {p.count}건</span>
                {!p.issuerReady ? <Badge tone="neutral">기관 영수증 정보 준비 중</Badge> : !profile ? <Badge tone="warning">내 정보 등록 필요</Badge> : <Badge tone="brand">발급 대기</Badge>}
              </div>
            ))}
          </div>
        ) : null}
        {overview.issued.length === 0 ? (
          <EmptyState title={`${year}년 발급된 영수증이 없습니다`} description="기관이 영수증을 발급하면 문자로 열람 링크를 보내 드리고 이곳에도 표시됩니다." />
        ) : (
          <ul className="divide-y divide-ink-100">
            {overview.issued.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div>
                  <p className="text-[14px] font-extrabold text-ink-900">{r.merchant.displayName} <Badge tone={receiptStatusLabel[r.status].tone}>{receiptStatusLabel[r.status].text}</Badge></p>
                  <p className="mt-0.5 text-[12px] text-ink-500">발급번호 <span className="font-mono">{r.receiptNo}</span> · {formatKst(r.issuedAt, false)} · {r.chargeCount}건</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-[15px] font-black tabular-nums">{formatWon(r.totalAmount)}</span>
                  <DonorActionForm action={openReceiptAction} submitLabel="열람·출력" variant="secondary" size="sm">
                    <input type="hidden" name="receiptId" value={r.id} />
                  </DonorActionForm>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Notice tone="neutral">
        영수증은 결제가 완료된 후원만 포함되며, 환불된 후원은 제외됩니다. 발급된 영수증에 포함된 후원이 환불되면 영수증은 무효 처리되고 기관이 남은 금액으로 재발급합니다. 문의는 <Link href="/support" className="font-bold underline">고객센터</Link>로 보내 주세요.
      </Notice>
    </div>
  );
}
