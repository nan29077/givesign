import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { featureContentEnabled } from '@/lib/env';
import { formatKst } from '@/lib/datetime';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, Checkbox, EmptyState, Field, Input, LinkButton, Notice, Select } from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { archiveContentAssetAction, linkPortraitConsentAction, uploadContentAssetAction } from '@/app/actions/weekly';
import {
  ASSET_PEOPLE,
  ASSET_PEOPLE_LABEL,
  ASSET_TAG_LABEL,
  ASSET_TAGS,
  assetUsability,
  CONSENT_STATE_LABEL,
  consentCandidates,
  type AssetPeople,
  type AssetTag,
} from '@/server/services/content-assets';

export const dynamic = 'force-dynamic';

/**
 * 콘텐츠 소재 (2026-11-11 G2-4) — 담당자가 휴대폰으로 사진·짧은 영상을 올린다.
 * 얼굴 여부는 담당자가 체크하고(자동 인식 없음), 얼굴 소재는 초상권 이용 동의서(전자문서)와 연결해야 콘텐츠에 쓸 수 있다.
 */
export default async function ContentAssetsPage({ searchParams }: { searchParams: Promise<{ archived?: string }> }) {
  if (!featureContentEnabled()) notFound();
  const { merchantId } = await requireMerchant();
  const sp = await searchParams;
  const archived = sp.archived === '1';
  const [assets, consents] = await Promise.all([
    prisma.contentAsset.findMany({ where: { merchantId, archivedAt: archived ? { not: null } : null }, orderBy: { createdAt: 'desc' }, take: 100 }),
    consentCandidates(merchantId),
  ]);
  const usability = new Map((await assetUsability(merchantId, assets.map((a) => a.id))).map((u) => [u.asset.id, u]));
  const okConsents = consents.filter((c) => c.state !== 'INVALID');

  return (
    <>
      <PageHeader
        title="콘텐츠 소재"
        description="행사·봉사·물품·시설 사진과 짧은 영상을 올려 두고 콘텐츠에 연결합니다. 파일은 기관 담당자만 볼 수 있습니다."
        action={<LinkButton href="/studio/content" variant="secondary" size="sm">콘텐츠 만들기</LinkButton>}
      />
      <Notice tone="neutral" title="초상권과 수혜자 보호">
        얼굴이 나온 소재는 전자문서 센터에서 「초상권 이용 동의서」를 보낸 뒤 그 서명 요청을 연결해야 콘텐츠에 쓸 수 있습니다. 아동·이용자 소재는 기본으로 &quot;가림 필요&quot; 가 표시됩니다. 수혜자 소재는 올려 둘 수는 있지만 콘텐츠에는 쓸 수 없습니다. 얼굴 인식은 자동으로 하지 않으니 직접 체크해 주세요.
      </Notice>

      <Card className="mt-4">
        <h2 className="text-[16px] font-black text-ink-900">소재 올리기</h2>
        <div className="mt-3">
          <ActionForm action={uploadContentAssetAction} submitLabel="올리기" pendingLabel="올리는 중">
            <Field label="사진 또는 짧은 영상" hint="사진 10MB · 영상 25MB 이하 (JPG·PNG·WEBP·HEIC·MP4·MOV)">
              <input type="file" name="file" accept="image/jpeg,image/png,image/webp,image/heic,video/mp4,video/quicktime" className="block w-full text-[14px]" required />
            </Field>
            <Field label="태그 (하나 이상)">
              <div className="flex flex-wrap gap-1.5">
                {ASSET_TAGS.map((t) => (
                  <label key={t} className="cursor-pointer rounded-lg border border-ink-200 px-3 py-2 text-[13px] font-bold has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50">
                    <input type="checkbox" name="tag" value={t} className="sr-only" />{ASSET_TAG_LABEL[t]}
                  </label>
                ))}
              </div>
            </Field>
            <Field label="나온 사람">
              <Select name="people" defaultValue="NONE">
                {ASSET_PEOPLE.map((p) => <option key={p} value={p}>{ASSET_PEOPLE_LABEL[p]}</option>)}
              </Select>
            </Field>
            <Checkbox name="hasFace" label="얼굴이 알아볼 수 있게 나왔습니다" description="체크하면 초상권 이용 동의서를 연결해야 콘텐츠에 쓸 수 있습니다." />
            <Field label="얼굴 가림" hint="비워 두면 아동·이용자 소재는 가림 필요로 표시합니다.">
              <Select name="blurRequired" defaultValue="">
                <option value="">자동(아동·이용자면 가림 필요)</option>
                <option value="1">가림 필요</option>
                <option value="0">가림 필요 없음</option>
              </Select>
            </Field>
            <Field label="메모 (선택)" hint="연락처·주민번호를 적지 마세요."><Input name="note" maxLength={200} placeholder="예: 11월 김장 나눔 행사" /></Field>
          </ActionForm>
        </div>
      </Card>

      <div className="mt-6 mb-3 flex flex-wrap gap-2">
        <Link href="/studio/content/assets" className={`rounded-full border px-3 py-1.5 text-[12.5px] font-bold ${!archived ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-200 bg-white text-ink-600'}`}>사용 중</Link>
        <Link href="/studio/content/assets?archived=1" className={`rounded-full border px-3 py-1.5 text-[12.5px] font-bold ${archived ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-200 bg-white text-ink-600'}`}>보관</Link>
      </div>
      {assets.length === 0 ? (
        <EmptyState title={archived ? '보관한 소재가 없습니다' : '올린 소재가 없습니다'} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {assets.map((a) => {
            const u = usability.get(a.id);
            const previewable = a.kind === 'IMAGE' && a.mime !== 'image/heic';
            return (
              <Card key={a.id} className="flex flex-col gap-2 p-3">
                <div className="flex gap-3">
                  <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-ink-50 text-[11px] text-ink-400">
                    {previewable ? (
                      // eslint-disable-next-line @next/next/no-img-element -- 비공개 소재(로그인 필요 경로)라 이미지 최적화를 쓰지 않는다
                      <img src={`/studio/content/assets/${a.id}/file`} alt="소재 미리보기" className={`h-full w-full object-cover ${a.blurRequired ? 'blur-sm' : ''}`} />
                    ) : (
                      <a href={`/studio/content/assets/${a.id}/file`} className="px-1 text-center font-bold text-brand-700">{a.kind === 'VIDEO' ? '영상 열기' : '파일 열기'}</a>
                    )}
                  </div>
                  <div className="min-w-0 flex-1 text-[12.5px]">
                    <div className="flex flex-wrap gap-1">
                      {a.tags.map((t) => <Badge key={t} tone={t === 'BENEFICIARY' ? 'danger' : 'neutral'}>{ASSET_TAG_LABEL[t as AssetTag] ?? t}</Badge>)}
                      {a.blurRequired ? <Badge tone="warning">가림 필요</Badge> : null}
                    </div>
                    <p className="mt-1 text-ink-600">{ASSET_PEOPLE_LABEL[a.people as AssetPeople] ?? a.people} · {a.hasFace ? '얼굴 나옴' : '얼굴 없음'} · {a.kind === 'VIDEO' ? '영상' : '사진'}</p>
                    {a.hasFace ? <p className="mt-0.5 font-bold text-ink-700">{u ? CONSENT_STATE_LABEL[u.consent] : '-'}{u?.consentTitle ? ` · ${u.consentTitle}` : ''}</p> : null}
                    {u && !u.usable ? <p className="mt-0.5 font-bold text-danger-500">콘텐츠 사용 불가 — {u.reasons[0]}</p> : <p className="mt-0.5 text-[#0b7d59]">콘텐츠에 쓸 수 있음</p>}
                    {a.note ? <p className="mt-0.5 text-ink-400">{a.note}</p> : null}
                    <p className="mt-0.5 text-[11px] text-ink-400">{formatKst(a.createdAt, false)}</p>
                  </div>
                </div>
                {a.hasFace && !archived ? (
                  okConsents.length ? (
                    <ActionForm action={linkPortraitConsentAction} submitLabel="동의서 연결" variant="secondary" size="sm">
                      <input type="hidden" name="id" value={a.id} />
                      <Select name="envelopeId" defaultValue={a.consentEnvelopeId ?? ''} aria-label="초상권 이용 동의서">
                        <option value="">연결 안 함</option>
                        {okConsents.map((c) => <option key={c.id} value={c.id}>{c.title} · {CONSENT_STATE_LABEL[c.state]} · {formatKst(c.sentAt, false)}</option>)}
                      </Select>
                    </ActionForm>
                  ) : (
                    <p className="text-[12px] text-ink-500">연결할 초상권 이용 동의서가 없습니다. <Link href="/studio/e-documents" className="font-bold text-brand-700">전자문서 센터</Link>에서 「초상권 이용 동의서」를 먼저 보내 주세요.</p>
                  )
                ) : null}
                <ActionForm action={archiveContentAssetAction} submitLabel={archived ? '되살리기' : '보관'} variant="ghost" size="sm">
                  <input type="hidden" name="id" value={a.id} />
                  {archived ? <input type="hidden" name="restore" value="1" /> : null}
                </ActionForm>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
