import { notFound } from 'next/navigation';
import { requireMerchant } from '@/server/auth';
import { env, featureContentEnabled } from '@/lib/env';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, Field, Input, Notice } from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { formatKst } from '@/lib/datetime';
import { PLATFORM_KINDS } from '@/server/adapters/sns';
import { CONTENT_KIND_SHORT } from '@/server/services/content';
import { snsIsMock } from '@/server/adapters/sns';
import { SNS_PLATFORM_GUIDE, platformFromSlug, SNS_PLATFORM_LABEL } from '@/server/adapters/sns/platforms';
import { SOCIAL_STATE_LABEL, socialPlatformStates, type SocialPlatformState } from '@/server/services/social-oauth';
import { connectChannelAction } from '@/app/actions/automation';

export const dynamic = 'force-dynamic';

const STATE_TONE: Record<SocialPlatformState, 'success' | 'warning' | 'neutral' | 'danger'> = {
  CONNECTED: 'success',
  CONNECTABLE: 'neutral',
  EXPIRED: 'danger',
  NO_KEYS: 'warning',
  NO_API: 'neutral',
  DB_PENDING: 'neutral',
  MOCK: 'warning',
};

/** 콜백이 넘기는 고정 오류 코드 → 문구 (주소에 문구 원문을 싣지 않는다) */
const ERROR_TEXT: Record<string, string> = {
  denied: '계정 연결 동의가 완료되지 않았습니다.',
  state_invalid: '연결 요청을 확인할 수 없습니다. 이 화면에서 다시 시작해 주세요.',
  state_expired: '연결 요청 시간(10분)이 지났습니다. 다시 시도해 주세요.',
  merchant_mismatch: '연결을 시작한 기관과 지금 로그인한 기관이 다릅니다.',
  exchange_failed: '공급자에서 토큰을 받지 못했습니다. 계정 권한·앱 역할을 확인하고 다시 시도해 주세요.',
  not_configured: '이 플랫폼의 연결 키가 아직 설정되지 않았습니다.',
  no_api: '이 플랫폼은 공개 게시 API 가 없어 계정을 연결하지 않습니다.',
  db_pending: '이 플랫폼은 아직 채널 저장 구조가 준비되지 않았습니다.',
  mock: 'SNS 연동이 mock 이라 계정 이름만 등록합니다.',
};

/** SNS 채널 연결 — 기관이 등록한 유튜브·인스타그램·페이스북·틱톡으로 승인된 콘텐츠를 게시한다. */
export default async function StudioChannelsPage({ searchParams }: { searchParams: Promise<{ connected?: string; error?: string; platform?: string }> }) {
  if (!featureContentEnabled()) notFound();
  const { merchantId } = await requireMerchant();
  const sp = await searchParams;
  const states = await socialPlatformStates(merchantId);
  const mock = snsIsMock();
  const connectedLabel = sp.connected ? platformFromSlug(sp.connected) : null;
  const errorPlatform = sp.platform ? platformFromSlug(sp.platform) : null;
  return (
    <>
      <PageHeader title="SNS 채널" description="기관 계정을 연결해 두면 승인된 숏폼·캠페인 이미지를 예약 시각에 자동으로 올립니다. 게시물 링크에는 유입 경로가 들어가 콘텐츠별 후원 전환이 집계됩니다." />
      {connectedLabel ? <Notice tone="brand" title={`${SNS_PLATFORM_LABEL[connectedLabel]} 계정을 연결했습니다`}>이제 승인된 콘텐츠를 이 채널로 예약 게시할 수 있습니다.</Notice> : null}
      {sp.error ? (
        <Notice tone="warning" title={errorPlatform ? `${SNS_PLATFORM_LABEL[errorPlatform]} 연결 실패` : '연결 실패'}>{ERROR_TEXT[sp.error] ?? '계정을 연결하지 못했습니다. 다시 시도해 주세요.'}</Notice>
      ) : null}
      {!env.automation.socialPublishEnabled ? (
        <Notice tone="neutral" title="자동 게시 준비 중">플랫폼 심사가 끝나면 열립니다. 채널은 미리 연결해 둘 수 있고, 그동안은 콘텐츠를 내려받아 직접 올립니다.</Notice>
      ) : null}
      {mock ? (
        <Notice tone="warning" title="SNS 연동 mock">실제 OAuth 연결 없이 계정 이름만 등록합니다. 게시해도 실제로 올라가지 않습니다.</Notice>
      ) : (
        <Notice tone="neutral" title="계정 로그인으로 연결">
          각 플랫폼의 동의 화면에서 기관 계정으로 로그인해 연결합니다. 연결 키가 설정된 플랫폼만 연결할 수 있고, 플랫폼 검수·감사 전에는 아래 제한이 있습니다.
          메타(인스타그램·페이스북)는 앱 검수 전까지 메타 앱에 역할(관리자·개발자·테스터)이 있는 계정만 동작합니다.
        </Notice>
      )}
      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        {states.map((s) => {
          const c = s.channel;
          const on = s.state === 'CONNECTED';
          const canOAuth = s.state === 'CONNECTABLE' || (!mock && s.state === 'EXPIRED' && s.missing.length === 0);
          return (
            <Card key={s.platform}>
              <div className="flex items-center justify-between">
                <h2 className="text-[17px] font-black text-ink-900">{s.label}</h2>
                <Badge tone={STATE_TONE[s.state]}>{SOCIAL_STATE_LABEL[s.state]}</Badge>
              </div>
              {on && c ? (
                <p className="mt-2 text-[13px] text-ink-700">
                  <b>{c.accountName}</b> · {formatKst(c.connectedAt, false)} {c.mock ? <Badge tone="warning" className="ml-1">mock</Badge> : null}
                  {!c.mock && c.expiresAt ? <span className="ml-1 text-ink-400">토큰 만료 {formatKst(c.expiresAt, false)} (자동 갱신)</span> : null}
                </p>
              ) : null}
              {s.state === 'EXPIRED' && c?.lastError ? <p className="mt-2 text-[12.5px] text-danger-500">{c.lastError}</p> : null}
              <p className="mt-3 text-[12.5px] leading-relaxed text-ink-500"><b>필요</b> {SNS_PLATFORM_GUIDE[s.platform].need}</p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-500"><b>심사</b> {SNS_PLATFORM_GUIDE[s.platform].review}</p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-500"><b>형식</b> {(PLATFORM_KINDS[s.platform as keyof typeof PLATFORM_KINDS] ?? []).map((k) => CONTENT_KIND_SHORT[k]).join(' · ') || '내려받아 직접 게시'}</p>
              <div className="mt-4">
                {s.state === 'NO_API' ? (
                  <p className="text-[12.5px] text-ink-500">콘텐츠 화면에서 장면·캡션을 내려받아 직접 게시해 주세요.</p>
                ) : on ? (
                  <ActionForm action={connectChannelAction} submitLabel="연결 해제" variant="ghost" size="sm" confirmMessage="연결을 해제하면 예약된 게시가 실패로 처리됩니다.">
                    <input type="hidden" name="platform" value={s.platform} />
                    <input type="hidden" name="intent" value="disconnect" />
                  </ActionForm>
                ) : mock && s.state === 'MOCK' && ['YOUTUBE', 'INSTAGRAM', 'FACEBOOK'].includes(s.platform) ? (
                  <ActionForm action={connectChannelAction} submitLabel="계정 등록 (mock)" size="sm">
                    <input type="hidden" name="platform" value={s.platform} />
                    <Field label="계정 이름"><Input name="accountName" placeholder={s.platform === 'YOUTUBE' || s.platform === 'NAVER_BLOG' || s.platform === 'KAKAO_CHANNEL' ? '햇살복지관' : '@sunshine_welfare'} /></Field>
                  </ActionForm>
                ) : canOAuth ? (
                  <a href={`/api/studio/social/${s.slug}/connect`} className="inline-flex items-center rounded-xl bg-brand-600 px-3 py-2 text-[13px] font-bold text-white">
                    {s.state === 'EXPIRED' ? '다시 연결' : '계정 로그인으로 연결'}
                  </a>
                ) : s.state === 'NO_KEYS' ? (
                  <p className="text-[12.5px] text-ink-500">관리자가 연결 키를 설정하면 연결할 수 있습니다. (없음: {s.missing.join(', ')})</p>
                ) : (
                  <p className="text-[12.5px] text-ink-500">{s.label} 연결은 준비되면 여기서 합니다.</p>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </>
  );
}
