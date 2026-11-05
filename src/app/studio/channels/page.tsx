import { notFound } from 'next/navigation';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { env, featureContentEnabled } from '@/lib/env';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, Field, Input, Notice } from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { formatKst } from '@/lib/datetime';
import { PLATFORM_GUIDE as GUIDE, PLATFORM_KINDS, PLATFORM_LABEL, PLATFORMS, snsIsMock } from '@/server/adapters/sns';
import { CONTENT_KIND_SHORT } from '@/server/services/content';
import { connectChannelAction } from '@/app/actions/automation';

export const dynamic = 'force-dynamic';

/** SNS 채널 연결 — 기관이 등록한 유튜브·인스타그램·페이스북·틱톡·네이버 블로그·카카오 채널로 승인된 콘텐츠를 게시한다. */
export default async function StudioChannelsPage() {
  if (!featureContentEnabled()) notFound();
  const { merchantId } = await requireMerchant();
  const channels = await prisma.socialChannel.findMany({ where: { merchantId } });
  const by = new Map(channels.map((c) => [c.platform, c]));
  const mock = snsIsMock();
  return (
    <>
      <PageHeader title="SNS 채널" description="기관 계정을 연결해 두면 승인된 숏폼·캠페인 이미지를 예약 시각에 자동으로 올립니다. 게시물 링크에는 유입 경로가 들어가 콘텐츠별 후원 전환이 집계됩니다." />
      {!env.automation.socialPublishEnabled ? (
        <Notice tone="neutral" title="자동 게시 준비 중">플랫폼 심사가 끝나면 열립니다. 채널은 미리 연결해 둘 수 있고, 그동안은 콘텐츠를 내려받아 직접 올립니다.</Notice>
      ) : null}
      {mock ? (
        <Notice tone="warning" title="SNS 연동 mock">실제 OAuth 연결 없이 계정 이름만 등록합니다. 게시해도 실제로 올라가지 않습니다.</Notice>
      ) : (
        <Notice tone="warning" title="계정 로그인 연동 준비 중">
          SNS 계정 로그인(OAuth) 연동이 아직 구현되지 않아 실제 채널을 연결할 수 없습니다. 계정 이름만으로 연결된 것처럼 표시하지 않습니다.
          그동안은 승인된 콘텐츠를 내려받아 직접 올려 주세요.
        </Notice>
      )}
      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        {PLATFORMS.map((p) => {
          const c = by.get(p);
          const on = c?.status === 'CONNECTED';
          return (
            <Card key={p}>
              <div className="flex items-center justify-between">
                <h2 className="text-[17px] font-black text-ink-900">{PLATFORM_LABEL[p]}</h2>
                <Badge tone={on ? 'success' : c?.status === 'PENDING_OAUTH' ? 'warning' : 'neutral'}>
                  {on ? '연결됨' : c?.status === 'EXPIRED' ? '토큰 만료' : c?.status === 'PENDING_OAUTH' ? '로그인 연동 대기' : '미연결'}
                </Badge>
              </div>
              {on ? <p className="mt-2 text-[13px] text-ink-700"><b>{c!.accountName}</b> · {formatKst(c!.connectedAt, false)} {c!.mock ? <Badge tone="warning" className="ml-1">mock</Badge> : null}</p> : null}
              <p className="mt-3 text-[12.5px] leading-relaxed text-ink-500"><b>필요</b> {GUIDE[p].need}</p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-500"><b>심사</b> {GUIDE[p].review}</p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-500"><b>형식</b> {PLATFORM_KINDS[p].map((k) => CONTENT_KIND_SHORT[k]).join(' · ')}</p>
              <div className="mt-4">
                {on ? (
                  <ActionForm action={connectChannelAction} submitLabel="연결 해제" variant="ghost" size="sm" confirmMessage="연결을 해제하면 예약된 게시가 실패로 처리됩니다.">
                    <input type="hidden" name="platform" value={p} />
                    <input type="hidden" name="intent" value="disconnect" />
                  </ActionForm>
                ) : mock ? (
                  <ActionForm action={connectChannelAction} submitLabel="계정 등록 (mock)" size="sm">
                    <input type="hidden" name="platform" value={p} />
                    <Field label="계정 이름"><Input name="accountName" placeholder={p === 'YOUTUBE' || p === 'NAVER_BLOG' || p === 'KAKAO_CHANNEL' ? '햇살복지관' : '@sunshine_welfare'} /></Field>
                  </ActionForm>
                ) : (
                  <p className="text-[12.5px] text-ink-500">{PLATFORM_LABEL[p]} 로그인 연동이 준비되면 여기서 연결합니다.</p>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </>
  );
}
