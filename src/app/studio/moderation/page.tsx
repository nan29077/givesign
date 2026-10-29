import { Badge, Card, EmptyState, Field, Input, Notice, SectionTitle, Select, Table, Td, Th } from '@/components/ui';
import { PageHeader } from '@/components/layout/console-shell';
import { ActionForm, InlineActionForm } from '@/components/studio/action-form';
import {
  createBannedWordAction,
  deleteBannedWordAction,
  toggleBannedWordAction,
  unblockPayerAction,
  addDefaultBannedWordsAction,
} from '@/app/actions/studio';
import { FilterTester } from '@/components/studio/filter-tester';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { formatKst } from '@/lib/datetime';

export const dynamic = 'force-dynamic';

const ACTION_LABEL: Record<string, { text: string; tone: 'neutral' | 'warning' | 'danger' }> = {
  BLOCK: { text: '차단 (지난 정책)', tone: 'danger' },
  MASK: { text: '마스킹 (별표 처리)', tone: 'warning' },
  FLAG: { text: '표시 (기록만)', tone: 'neutral' },
};

export default async function StudioModerationPage() {
  const { merchantId } = await requireMerchant();

  const [myWords, globalWords, blocked, blockHistory] = await Promise.all([
    prisma.bannedWord.findMany({
      where: { merchantId, scope: 'MERCHANT' },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.bannedWord.findMany({
      where: { scope: 'GLOBAL', active: true },
      orderBy: { word: 'asc' },
      select: { id: true, word: true, action: true },
    }),
    prisma.blockedPayer.findMany({
      where: { merchantId },
      orderBy: { createdAt: 'desc' },
      include: { payer: { select: { id: true, phoneMasked: true, displayName: true } } },
    }),
    // 정책 변경 전에 금칙어로 접수 거부됐던 문자 (이력 확인용. 지금은 새로 생기지 않는다)
    prisma.charge.findMany({
      where: { merchantId, status: 'CONTENT_BLOCKED' },
      orderBy: { receivedAt: 'desc' },
      take: 20,
      select: { id: true, displayName: true, message: true, statusReason: true, receivedAt: true },
    }),
  ]);

  return (
    <>
      <PageHeader title="금칙어 · 차단" description="후원 내역과 문자에 노출되는 문자 내용과 후원자를 직접 관리합니다." />

      <div className="space-y-5">
        <Notice tone="neutral" title="금칙어는 결제를 막지 않고 기록만 가립니다">
          전역 금칙어가 먼저 적용되고, 그 뒤에 내 금칙어가 적용됩니다. 마스킹(MASK)은 해당 부분만 별표로 가려
          표시하고, 표시(FLAG)는 기록만 남깁니다. <strong className="font-bold">어느 쪽이든 결제는 그대로 접수됩니다.</strong>
          지난 정책으로 남아 있는 차단(BLOCK) 규칙도 지금은 마스킹으로 동작합니다.
        </Notice>

        <section>
          <SectionTitle title="금칙어 미리보기" description="문장을 넣어 실제 노출 결과를 미리 확인합니다. (결제가 생성되지 않습니다)" />
          <Card>
            <FilterTester />
          </Card>
        </section>

        <section>
          <SectionTitle title="내 금칙어 추가" />
          <Card>
            <ActionForm action={createBannedWordAction} submitLabel="금칙어 추가">
              <div className="grid gap-3 md:grid-cols-[2fr_1fr]">
                <Field label="금칙어" hint="1~40자. 글자 사이 공백·기호를 끼운 우회 표기도 함께 잡습니다.">
                  <Input name="word" maxLength={40} placeholder="예: 특정 비속어" />
                </Field>
                <Field label="처리 방식">
                  <Select name="action" defaultValue="MASK">
                    <option value="MASK">마스킹 (별표 처리)</option>
                    <option value="FLAG">표시 (기록만)</option>
                  </Select>
                </Field>
              </div>
            </ActionForm>
            <div className="mt-3 border-t border-ink-100 pt-3">
              <InlineActionForm
                action={addDefaultBannedWordsAction}
                submitLabel="기본 비속어 세트 추가"
                confirmMessage="자주 쓰이는 비속어를 마스킹으로 한 번에 추가합니다."
                fields={{}}
              />
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-400">
                처음이라면 기본 세트로 시작한 뒤, 필요한 단어만 추가하거나 처리 방식을 조정하는 것을 권장합니다.
              </p>
            </div>
          </Card>
        </section>

        <section>
          <SectionTitle title="내 금칙어" description={`${myWords.length}건 등록됨`} />
          {myWords.length === 0 ? (
            <EmptyState title="등록한 금칙어가 없습니다" description="후원 내역에 남지 않았으면 하는 단어를 추가해 보세요." />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>단어</Th>
                  <Th>처리 방식</Th>
                  <Th>사용 여부</Th>
                  <Th>등록일</Th>
                  <Th>관리</Th>
                </tr>
              </thead>
              <tbody>
                {myWords.map((w) => {
                  const label = ACTION_LABEL[w.action] ?? ACTION_LABEL.FLAG;
                  return (
                    <tr key={w.id}>
                      <Td className="font-semibold text-ink-900">{w.word}</Td>
                      <Td>
                        <Badge tone={label.tone}>{label.text}</Badge>
                      </Td>
                      <Td>
                        <Badge tone={w.active ? 'success' : 'neutral'}>{w.active ? '사용 중' : '중지'}</Badge>
                      </Td>
                      <Td className="whitespace-nowrap tabular-nums">{formatKst(w.createdAt, false)}</Td>
                      <Td>
                        <div className="flex flex-wrap gap-1.5">
                          <InlineActionForm
                            action={toggleBannedWordAction}
                            submitLabel={w.active ? '사용 중지' : '다시 사용'}
                            fields={{ id: w.id }}
                          />
                          <InlineActionForm
                            action={deleteBannedWordAction}
                            submitLabel="삭제"
                            variant="danger"
                            confirmMessage={`금칙어 "${w.word}"를 삭제하시겠습니까?`}
                            fields={{ id: w.id }}
                          />
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </section>

        <section>
          <SectionTitle title="전역 금칙어" description="플랫폼 공통 금칙어입니다. 사회복지기관은 변경할 수 없습니다." />
          {globalWords.length === 0 ? (
            <EmptyState title="등록된 전역 금칙어가 없습니다" />
          ) : (
            <Card>
              <div className="flex flex-wrap gap-1.5">
                {globalWords.map((w) => (
                  <Badge key={w.id} tone={w.action === 'BLOCK' ? 'danger' : w.action === 'MASK' ? 'warning' : 'neutral'}>
                    {w.word}
                  </Badge>
                ))}
              </div>
              <p className="mt-2.5 text-[12px] leading-relaxed text-ink-400">
                노란색은 마스킹, 회색은 기록만 하는 단어입니다.
              </p>
            </Card>
          )}
        </section>

        <section>
          <SectionTitle title="차단된 후원자" description={`${blocked.length}명`} />
          {blocked.length === 0 ? (
            <EmptyState title="차단된 후원자가 없습니다" description="후원 내역이나 문자 관리 화면에서 차단할 수 있습니다." />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>후원자</Th>
                  <Th>표시명</Th>
                  <Th>사유</Th>
                  <Th>차단일</Th>
                  <Th>관리</Th>
                </tr>
              </thead>
              <tbody>
                {blocked.map((b) => (
                  <tr key={b.id}>
                    <Td className="whitespace-nowrap tabular-nums">{b.payer.phoneMasked}</Td>
                    <Td>{b.payer.displayName ?? '-'}</Td>
                    <Td>{b.reason ?? '-'}</Td>
                    <Td className="whitespace-nowrap tabular-nums">{formatKst(b.createdAt, false)}</Td>
                    <Td>
                      <InlineActionForm
                        action={unblockPayerAction}
                        submitLabel="차단 해제"
                        confirmMessage="이 후원자의 차단을 해제하시겠습니까?"
                        fields={{ payerId: b.payer.id }}
                      />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>

        <section>
          <SectionTitle
            title="지난 금칙어 차단 이력"
            description="정책 변경 전, 금칙어로 접수가 거부됐던 문자입니다. 지금은 금칙어가 결제를 막지 않고 기록만 마스킹합니다."
          />
          {blockHistory.length === 0 ? (
            <EmptyState title="차단된 문자가 없습니다" description="지금 정책에서는 새로 쌓이지 않습니다." />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>시각</Th>
                  <Th>보낸 사람</Th>
                  <Th>내용</Th>
                  <Th>차단 사유</Th>
                </tr>
              </thead>
              <tbody>
                {blockHistory.map((d) => (
                  <tr key={d.id}>
                    <Td className="whitespace-nowrap tabular-nums">{formatKst(d.receivedAt, false)}</Td>
                    <Td>{d.displayName}</Td>
                    <Td className="max-w-[280px] break-words text-ink-500">{d.message}</Td>
                    <Td className="max-w-[220px] break-words text-[12px] text-danger-500">{d.statusReason ?? '-'}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>
      </div>
    </>
  );
}
