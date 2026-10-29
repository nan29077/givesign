import { ShieldCheck, ShieldAlert, TriangleAlert } from 'lucide-react';
import { Badge, Card, CardTitle, Notice } from '@/components/ui';
import { env, assertProductionSafety } from '@/lib/env';

/**
 * 운영 안전 배너.
 * 실제 계약이 없는 외부 연동은 mock 어댑터로 동작하며, 그 사실을 화면에 항상 명시한다.
 */

const providerRows: Array<{ key: string; label: string }> = [
  { key: 'payment', label: '결제(PG)' },
  { key: 'mo', label: 'MO 수신' },
  { key: 'mt', label: 'MT 발송' },
];

export function SafetyBanner() {
  const providers: Record<string, string> = {
    payment: env.payment.provider,
    mo: env.mo.provider,
    mt: env.mt.provider,
  };
  const warnings = assertProductionSafety();
  const mockCount = providerRows.filter((r) => providers[r.key] === 'mock').length;

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-ink-50 text-brand-700">
            {warnings.length > 0 ? (
              <ShieldAlert size={18} strokeWidth={1.7} />
            ) : (
              <ShieldCheck size={18} strokeWidth={1.7} />
            )}
          </span>
          <CardTitle>운영 안전 상태</CardTitle>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone="neutral">환경 {env.appEnv}</Badge>
          <Badge tone={env.safety.safeMode ? 'success' : 'danger'}>
            SAFE_MODE {env.safety.safeMode ? '켜짐' : '꺼짐'}
          </Badge>
          <Badge tone={env.safety.allowDirectTrigger ? 'warning' : 'neutral'}>
            즉시형 결제 {env.safety.allowDirectTrigger ? '허용' : '차단'}
          </Badge>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
        {providerRows.map((r) => {
          const mode = providers[r.key];
          const isMock = mode === 'mock';
          return (
            <div key={r.key} className="rounded-lg border border-ink-100 px-2.5 py-2">
              <p className="text-[11px] text-ink-400">{r.label}</p>
              <p className={`mt-0.5 text-[12px] font-bold ${isMock ? 'text-warning-500' : 'text-success-500'}`}>
                {isMock ? 'mock' : mode}
              </p>
            </div>
          );
        })}
      </div>

      {mockCount > 0 ? (
        <Notice tone="warning" title={`외부 연동 ${mockCount}개가 mock 어댑터로 동작 중입니다`}>
          mock 어댑터는 실제 결제·문자 발송을 수행하지 않습니다. 화면에 표시되는 성공 결과는 모의 처리
          결과이며, 실계약 체결 후 어댑터를 교체해야 실제 처리로 전환됩니다.
        </Notice>
      ) : null}

      {env.safety.safeMode ? (
        <Notice tone="brand" title="SAFE_MODE 가 켜져 있습니다">
          실제 결제 승인과 실제 MT 문자 발송이 차단되고 mock 으로 대체됩니다. 운영 전환 시 SAFE_MODE=false 로 변경해야
          합니다.
        </Notice>
      ) : null}

      {!env.safety.allowDirectTrigger ? (
        <Notice tone="neutral" title="즉시형(DIRECT_TRIGGER) 결제 비활성">
          금융사 서면승인이 등록되지 않아 즉시형 결제를 활성화할 수 없습니다. 모든 결제는 확인형(MT 링크 확인 후 결제)
          으로만 처리됩니다.
        </Notice>
      ) : null}

      {warnings.length > 0 ? (
        <Notice tone="danger" title="운영 배포 전 반드시 해결해야 하는 항목">
          <ul className="mt-1 space-y-1">
            {warnings.map((w) => (
              <li key={w} className="flex items-start gap-1.5">
                <TriangleAlert size={14} strokeWidth={1.7} className="mt-0.5 shrink-0" />
                <span>{w}</span>
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}
    </Card>
  );
}
