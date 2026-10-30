import { notFound } from 'next/navigation';
import { Badge, Card, CardTitle, DataRow, EmptyState, Field, Input, Notice, SectionTitle, Table, Td, Th } from '@/components/ui';
import { PageHeader } from '@/components/layout/console-shell';
import { ActionForm } from '@/components/studio/action-form';
import { ImageUploadField } from '@/components/studio/image-upload-field';
import { updateMerchantProfileAction } from '@/app/actions/studio';
import { saveOrganizationInfoAction } from '@/app/actions/fundraising';
import { OrganizationInfoForm } from '@/components/studio/organization-info-form';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { formatKst } from '@/lib/datetime';
import { merchantStatusLabel } from '@/lib/labels';
import { OrgLogo, isCustomLogo } from '@/components/brand/org-logo';

export const dynamic = 'force-dynamic';

export default async function StudioSettingsProfilePage() {
  const { merchantId, email, avatarIndex } = await requireMerchant();

  const merchant = await prisma.merchantProfile.findUnique({
    where: { id: merchantId },
    include: { codes: { orderBy: { issuedAt: 'desc' }, take: 10 } },
  });

  if (!merchant) notFound();

  const status = merchantStatusLabel[merchant.status];

  return (
    <>
      <PageHeader
        title="기관 정보"
        description="기관 프로필과 기부금영수증에 인쇄되는 기관 정보를 관리합니다. 후원페이지 꾸미기는 모금 > 후원페이지에 있습니다."
      />

      <div className="space-y-5">
        <section>
          <SectionTitle title="기관 상태" />
          <Card>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <CardTitle>{merchant.displayName}</CardTitle>
              <Badge tone={status.tone}>{status.text}</Badge>
            </div>
            <DataRow label="로그인 계정" value={email ?? '-'} />
            <DataRow label="사회복지기관 코드" value={<span className="font-mono">{merchant.code}</span>} />
            <DataRow label="승인 시각" value={formatKst(merchant.approvedAt)} />
            <DataRow label="가입 시각" value={formatKst(merchant.createdAt)} />
            {merchant.suspendedAt ? <DataRow label="정지 시각" value={formatKst(merchant.suspendedAt)} /> : null}
          </Card>
        </section>

        <section>
          <SectionTitle
            title="프로필 수정"
            description="후원 페이지와 결제 알림에 표시되는 정보입니다. 사회복지기관 소개는 후원 설정 > 후원 페이지 탭에서 수정합니다."
          />
          <Card>
            <div className="mb-5 flex items-center gap-3 rounded-2xl border border-brand-100 bg-brand-50/60 p-4">
              <OrgLogo code={merchant.code} name={merchant.displayName} logoUrl={merchant.avatarUrl} avatarIndex={avatarIndex} className="h-16 w-16" />
              <div>
                <p className="text-[14px] font-extrabold text-ink-900">{isCustomLogo(merchant.avatarUrl) ? '현재 기관 로고' : '기관 로고 미등록 (기본 캐릭터 표시 중)'}</p>
                <p className="mt-1 text-[12px] leading-relaxed text-ink-500">
                  기관 로고는 기관 콘솔 프로필, 공개 후원페이지 상단·기관 카드·메뉴에 함께 쓰입니다. 등록하기 전에는 기관마다 배정된 기본 캐릭터가 표시됩니다.
                </p>
              </div>
            </div>
            <ActionForm action={updateMerchantProfileAction} submitLabel="프로필 저장">
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="표시명" hint="1~30자" required>
                  <Input name="displayName" maxLength={30} defaultValue={merchant.displayName} />
                </Field>
                <Field label="채널명" hint="50자 이내. 비워두면 표시하지 않습니다.">
                  <Input name="channelName" maxLength={50} defaultValue={merchant.channelName ?? ''} />
                </Field>
              </div>
              <ImageUploadField
                name="avatarUrl"
                label="기관 로고"
                aspect="square"
                defaultValue={merchant.avatarUrl ?? ''}
                hint="정사각형에 가까운 로고(PNG·JPG, 배경 투명 권장)를 올리세요. 잘리지 않게 원본 비율로 표시합니다. 비워 두면 기본 캐릭터가 표시됩니다."
              />
            </ActionForm>
          </Card>
        </section>

        <section>
          <SectionTitle
            title="기관 정보 (기부금영수증 발급 주체)"
            description="고유번호·대표자·소재지는 기부금영수증 서식에 그대로 인쇄됩니다. 공익법인 지정 여부가 확인돼야 영수증을 발급할 수 있습니다."
          />
          <Card>
            <OrganizationInfoForm action={saveOrganizationInfoAction} merchant={merchant} />
          </Card>
        </section>

        <section>
          <SectionTitle title="코드 이력" description="코드 발급과 회수는 통합 관리자가 처리합니다." />
          {merchant.codes.length === 0 ? (
            <EmptyState title="코드 이력이 없습니다" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>코드</Th>
                  <Th>상태</Th>
                  <Th>발급일</Th>
                  <Th>회수일</Th>
                </tr>
              </thead>
              <tbody>
                {merchant.codes.map((c) => (
                  <tr key={c.id}>
                    <Td className="font-mono font-semibold text-ink-900">{c.code}</Td>
                    <Td>
                      <Badge tone={c.active ? 'success' : 'neutral'}>{c.active ? '사용 중' : '회수됨'}</Badge>
                    </Td>
                    <Td className="whitespace-nowrap tabular-nums">{formatKst(c.issuedAt, false)}</Td>
                    <Td className="whitespace-nowrap tabular-nums">{formatKst(c.revokedAt, false)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>

        <Notice tone="neutral">
          표시명과 소개는 후원 페이지에 그대로 노출됩니다. 개인 연락처나 계좌번호 등 개인정보는 입력하지 마세요.
          기관 상태 변경(승인·정지)과 기관 코드 변경은 통합 관리자를 통해서만 가능합니다.
        </Notice>
      </div>
    </>
  );
}
