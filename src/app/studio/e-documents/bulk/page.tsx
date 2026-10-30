import Link from 'next/link';
import { requireMerchant } from '@/server/auth';
import { PageHeader } from '@/components/layout/console-shell';
import { Card, Field, Input, LinkButton, Notice, Select, Textarea } from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { createEDocBulkAction } from '@/app/actions/edoc';
import { edocRoleLabel } from '@/server/services/edoc';
import { walletOverview } from '@/server/services/edoc-billing';
import { newId } from '@/lib/id';
import { composeTemplates } from '../_data';

export const dynamic = 'force-dynamic';

/** 여러 명에게 같은 서식을 보낸다(서명자 1명짜리 문서). 줄마다 1건씩 차감한다. */
export default async function BulkEDocPage() {
  const { merchantId } = await requireMerchant();
  const [templates, o] = await Promise.all([composeTemplates(merchantId), walletOverview(merchantId)]);
  return (
    <>
      <PageHeader title="여러 명에게 보내기" description="같은 서식을 받는 분마다 따로 보냅니다. 한 줄에 한 명씩 이름과 휴대폰 번호를 넣어 주세요." action={<LinkButton href="/studio/e-documents" variant="secondary">전자문서 센터</LinkButton>} />
      {templates.length === 0 ? (
        <Notice tone="brand">먼저 <Link href="/studio/documents/new?type=preset" className="font-bold underline">서식을 등록</Link>해 주세요.</Notice>
      ) : (
        <Card className="max-w-3xl">
          <ActionForm action={createEDocBulkAction} submitLabel="모두 보내기" confirmTitle="여러 명에게 보낼까요?" confirmMessage="받는 분 1명마다 이용료 1건을 차감합니다. 잔액이 떨어지면 거기서 멈추고, 같은 화면에서 다시 눌러도 이미 보낸 줄은 다시 보내지 않습니다." confirmActionLabel="보내기">
            <input type="hidden" name="nonce" value={newId()} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="서식" required>
                <Select name="templateId" required>
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </Select>
              </Field>
              <Field label="받는 분 역할">
                <Select name="role" defaultValue="DONOR">
                  {Object.entries(edocRoleLabel).filter(([k]) => k !== 'STAFF').map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
              </Field>
              <Field label="문서 제목" hint="비워 두면 서식 이름">
                <Input name="title" maxLength={60} />
              </Field>
              <Field label="서명 기한">
                <Select name="expiresDays" defaultValue="14">
                  <option value="7">7일</option>
                  <option value="14">14일</option>
                  <option value="30">30일</option>
                </Select>
              </Field>
            </div>
            <Field label="받는 분 목록" required hint="이름, 휴대폰 — 한 줄에 한 명. 엑셀에서 두 열을 복사해 붙여 넣어도 됩니다(탭 구분). 최대 200명.">
              <Textarea name="recipients" rows={10} required placeholder={'홍길동, 010-1234-5678\n김나눔, 010-2345-6789'} className="font-mono text-[13px]" />
            </Field>
            <Field label="안내 문구" hint="서명 화면 위쪽에 보입니다.">
              <Textarea name="message" rows={2} maxLength={300} />
            </Field>
            <Notice tone="neutral">
              지금 보낼 수 있는 건수는 {o.sendable.toLocaleString('ko-KR')}건입니다(정액 {o.monthlyLeft} · 시범 {o.wallet.trialRemaining} · 충전 {o.prepaidDocs}). 여러 명이 함께 서명하는 문서는 한 건씩 <Link href="/studio/e-documents/new" className="font-bold underline">서명 요청 보내기</Link>에서 보내 주세요.
            </Notice>
          </ActionForm>
        </Card>
      )}
    </>
  );
}
