import Link from 'next/link';
import { FileSignature, FileCheck2, Users, HeartHandshake, Receipt, ShieldCheck } from 'lucide-react';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { getEDocAccount, getEDocPolicy } from '@/server/services/edoc-billing';
import { createEDocRequest } from '@/app/actions/edoc';
import { ActionForm } from '@/components/studio/action-form';
import { PageHeader } from '@/components/layout/console-shell';
import { Card, Field, Input, Select, LinkButton, Notice } from '@/components/ui';
import { documentStatusLabel } from '@/server/services/documents';
import { formatKst } from '@/lib/datetime';

export const dynamic = 'force-dynamic';
export default async function ElectronicDocuments() {
  const { merchantId } = await requireMerchant();
  const [account, policy, templates, requests] = await Promise.all([
    getEDocAccount(merchantId), getEDocPolicy(),
    prisma.documentTemplate.findMany({ where: { merchantId, active: true, archivedAt: null }, orderBy: { createdAt: 'desc' } }),
    prisma.documentSubmission.findMany({ where: { merchantId }, include: { template: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: 50 }),
  ]);
  return <><PageHeader title="기관 전자문서 센터" description="후원약정부터 봉사 신청, 서명·제출·확인·보관까지. 후원 결제와 별개로 작성 요청을 보낼 수 있습니다." action={<LinkButton href="/studio/document-billing">충전·정액 이용 관리</LinkButton>} />
    <div className="mb-6 grid gap-3 sm:grid-cols-3"><Card><p className="text-sm text-ink-500">충전 잔액</p><p className="mt-2 text-2xl font-black">{account.balance.toLocaleString()}원</p><p className="mt-2 text-xs text-ink-400">작성 요청당 {policy.perDocument.toLocaleString()}원</p></Card><Card><p className="text-sm text-ink-500">정액 잔여량</p><p className="mt-2 text-2xl font-black">{account.monthlyRemaining}건</p><p className="mt-2 text-xs text-ink-400">{account.monthlyUntil ? `${formatKst(new Date(account.monthlyUntil), false)}까지` : '정액 이용 신청 후 활성화'}</p></Card><Card><p className="text-sm text-ink-500">시범 이용</p><p className="mt-2 text-2xl font-black">{account.trialRemaining}건</p><p className="mt-2 text-xs text-ink-400">총 작성 요청 {account.totalUsed}건</p></Card></div>
    <section className="mb-7 grid gap-3 sm:grid-cols-3">{[{ title: '후원약정서', icon: HeartHandshake, href: '/studio/documents/new?type=preset&preset=SUPPORT_AGREEMENT', body: '후원 의사·금액·주기와 자필서명 기록' }, { title: '자원봉사 신청서', icon: Users, href: '/studio/documents/new?type=preset&preset=VOLUNTEER_APPLICATION', body: '활동 희망일·분야·연락처·참여 동의' }, { title: '기부금영수증', icon: Receipt, href: '/studio/receipts', body: '검증된 후원 실적에 따른 발급·보관·출력' }].map(({ title, icon: Icon, href, body }) => <Link href={href} key={title}><Card className="h-full transition hover:border-brand-400"><Icon size={23} className="text-brand-700" /><h2 className="mt-4 font-bold">{title}</h2><p className="mt-2 text-sm leading-6 text-ink-500">{body}</p></Card></Link>)}</section>
    <div className="mb-6 flex flex-wrap gap-3"><LinkButton href="/studio/documents/new">서식 만들기·파일 업로드</LinkButton><LinkButton href="/studio/documents">서식·제출 문서 관리</LinkButton></div>
    <Card className="mb-6"><h2 className="mb-4 flex items-center gap-2 text-lg font-black"><FileSignature size={20} /> 새 작성 요청</h2>{templates.length ? <ActionForm action={createEDocRequest} submitLabel="작성 요청 링크 생성" confirmMessage="작성 요청 1건을 생성하고 정액 제공량, 시범 제공량 또는 충전 잔액에서 이용료를 차감합니다. 재열람·제출·기관 확인에는 추가 차감하지 않습니다.">
      <input type="hidden" name="nonce" value={newId()} /><Field label="기관 서식" required><Select name="templateId" required>{templates.map(t => <option value={t.id} key={t.id}>{t.name}</option>)}</Select></Field><div className="grid gap-4 sm:grid-cols-2"><Field label="수신인 이름" required><Input name="recipientName" maxLength={40} required /></Field><Field label="수신인 휴대폰" required><Input name="recipientPhone" type="tel" placeholder="010-1234-5678" required /></Field></div><Notice tone="neutral">발급된 보안 링크를 수신인에게 전달하세요. 문자 요청·재전송은 문서 상세 화면에서 할 수 있습니다. 공인 본인인증·TSA·카카오 인증서는 연동 전이며, 자필서명과 제출 시각·접속 기록을 저장합니다.</Notice>
    </ActionForm> : <Notice tone="brand">먼저 후원약정서나 자원봉사 신청서 등 기관 서식을 등록해 주세요.</Notice>}</Card>
    <Card><h2 className="mb-4 flex items-center gap-2 text-lg font-black"><FileCheck2 size={20} /> 최근 작성 요청</h2><div className="space-y-3">{requests.length ? requests.map(r => <Link key={r.id} href={`/studio/documents/submissions/${r.id}`} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ink-100 p-4"><div><p className="font-bold">{r.template.name}</p><p className="mt-1 text-xs text-ink-500">{r.payerNameMasked || '수신인'} · {r.payerPhoneMasked || '-'} · {formatKst(r.createdAt, false)}</p></div><span className="rounded-full bg-brand-50 px-3 py-1 text-xs font-bold text-brand-700">{r.status === 'DRAFT' && r.expiresAt < new Date() ? '기간 만료' : documentStatusLabel[r.status].text}</span></Link>) : <p className="text-sm text-ink-500">아직 생성한 작성 요청이 없습니다.</p>}</div></Card>
    <p className="mt-5 flex gap-2 text-xs leading-6 text-ink-500"><ShieldCheck className="shrink-0" size={17} />수신인·작성 내용은 암호화하며 기관 담당자의 원문 열람은 감사로그에 기록합니다. 기부금영수증은 일반 서식으로 임의 발행하지 않고 영수증 대장에서 발급합니다.</p>
  </>;
}
