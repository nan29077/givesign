import Link from 'next/link';
import { prisma } from '@/server/db';
import { Badge, Card, Select } from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { attachContentAssetAction } from '@/app/actions/weekly';
import { ASSET_PEOPLE_LABEL, ASSET_TAG_LABEL, assetUsability, CONSENT_STATE_LABEL, type AssetPeople, type AssetTag } from '@/server/services/content-assets';
import { CONTENT_STATUS_LABEL } from '@/server/services/content';

/**
 * 콘텐츠 상세의 소재 연결 패널(2026-11-11 G). 서버 컴포넌트.
 * 검토 대기일 때만 연결할 수 있고, 얼굴 소재는 초상권 동의서가 있어야 연결된다(서비스가 다시 검사한다).
 */
export async function ContentAssetPanel({
  merchantId,
  itemId,
  status,
  assetIds,
  variantLabel,
  variantGroupId,
}: {
  merchantId: string;
  itemId: string;
  status: string;
  assetIds: string[];
  variantLabel: string | null;
  variantGroupId: string | null;
}) {
  const [linked, candidates, siblings] = await Promise.all([
    assetUsability(merchantId, assetIds),
    status === 'REVIEW'
      ? prisma.contentAsset.findMany({ where: { merchantId, archivedAt: null, id: { notIn: assetIds } }, orderBy: { createdAt: 'desc' }, take: 50 })
      : Promise.resolve([]),
    variantGroupId ? prisma.contentItem.findMany({ where: { variantGroupId, id: { not: itemId } }, select: { id: true, variantLabel: true, status: true }, orderBy: { createdAt: 'desc' } }) : Promise.resolve([]),
  ]);
  const usableCandidates = candidates.filter((a) => !a.tags.includes('BENEFICIARY'));
  const label = (tags: string[], people: string) => `${tags.map((t) => ASSET_TAG_LABEL[t as AssetTag] ?? t).join('·')} · ${ASSET_PEOPLE_LABEL[people as AssetPeople] ?? people}`;

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[16px] font-black text-ink-900">소재 · 초상권 동의서</h2>
        <Link href="/studio/content/assets" className="text-[12.5px] font-bold text-brand-700">소재 올리기·관리</Link>
      </div>
      {variantLabel ? (
        <p className="mt-2 text-[12.5px] text-ink-600">
          <Badge tone="brand">2안 비교 {variantLabel}안</Badge>{' '}
          두 안을 모두 승인하면 나눠 게시하고 클릭으로 비교합니다. 한쪽만 승인하면 그 안만 게시합니다.
          {siblings.map((s) => (
            <Link key={s.id} href={`/studio/content/${s.id}`} className="ml-2 font-bold text-brand-700">{s.variantLabel}안 보기({CONTENT_STATUS_LABEL[s.status] ?? s.status})</Link>
          ))}
        </p>
      ) : null}
      <p className="mt-2 text-[12px] leading-relaxed text-ink-400">소재는 게시할 때 쓰는 사진·영상 자료입니다. 장면 이미지에 자동으로 합성하지 않습니다. 얼굴이 나온 소재는 초상권 이용 동의서를 보냈거나 서명을 받은 것만 쓸 수 있고, 수혜자 소재는 쓸 수 없습니다.</p>
      {linked.length ? (
        <ul className="mt-3 divide-y divide-ink-100">
          {linked.map((u) => (
            <li key={u.asset.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-[13px]">
              <span className="min-w-0">
                <span className="font-bold text-ink-900">{label(u.asset.tags, u.asset.people)}</span>
                <span className="ml-2 text-[12px] text-ink-500">{u.asset.hasFace ? CONSENT_STATE_LABEL[u.consent] : '얼굴 없음'}</span>
                {!u.usable ? <span className="ml-2 text-[12px] font-bold text-danger-500">{u.reasons[0]}</span> : null}
                {u.warnings.map((w) => <span key={w} className="ml-2 text-[12px] text-warning-500">{w}</span>)}
              </span>
              {status === 'REVIEW' || status === 'APPROVED' ? (
                <ActionForm action={attachContentAssetAction} submitLabel="연결 풀기" variant="ghost" size="sm">
                  <input type="hidden" name="itemId" value={itemId} />
                  <input type="hidden" name="assetId" value={u.asset.id} />
                  <input type="hidden" name="intent" value="detach" />
                </ActionForm>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-[13px] text-ink-400">연결한 소재가 없습니다.</p>
      )}
      {status === 'REVIEW' && usableCandidates.length ? (
        <div className="mt-3">
          <ActionForm action={attachContentAssetAction} submitLabel="소재 연결" variant="secondary" size="sm">
            <input type="hidden" name="itemId" value={itemId} />
            <Select name="assetId" aria-label="연결할 소재">
              {usableCandidates.map((a) => (
                <option key={a.id} value={a.id}>{label(a.tags, a.people)}{a.hasFace ? (a.consentEnvelopeId ? ' · 동의서 연결됨' : ' · 동의서 필요') : ''} · {a.kind === 'VIDEO' ? '영상' : '사진'}</option>
              ))}
            </Select>
          </ActionForm>
        </div>
      ) : null}
    </Card>
  );
}
