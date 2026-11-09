/**
 * 배치 목록(한 곳). 외부 스케줄러(EventBridge 등)에 등록할 주기를 여기에 선언하고,
 * 관리자 화면(/admin/automation)이 cron_heartbeat 와 비교해 지연을 판단한다.
 *
 * 주기를 바꾸면 스케줄러 등록도 함께 바꾼다. 배포 가이드: docs/AWS-배포-가이드.md
 */
export interface CronDef {
  name: string;
  path: string;
  /** 사람이 읽는 주기(KST) */
  schedule: string;
  /** EventBridge cron 식(UTC) — 등록할 때 그대로 쓴다 */
  eventBridge: string;
  /** 예상 간격(초). 마지막 성공이 이 값의 3배를 넘으면 지연으로 본다. */
  intervalSec: number;
  lockTtlSec: number;
  description: string;
  /** 잠금 저장소 장애 때도 실행할지(중복 방지가 DB 유니크로 보장되는 수신 배치만) */
  failOpenLock?: boolean;
}

export const CRON_JOBS: CronDef[] = [
  {
    name: 'emma-mo', path: '/api/cron/emma-mo', schedule: '15초마다', eventBridge: 'rate(1 minute) ×4 오프셋',
    intervalSec: 15, lockTtlSec: 50, failOpenLock: true,
    description: 'EMMA 문자 수신 폴링 → 후원 접수 (EMMA_ENABLED 일 때만)',
  },
  {
    name: 'cleanup', path: '/api/cron/cleanup', schedule: '1분마다', eventBridge: 'rate(1 minute)',
    intervalSec: 60, lockTtlSec: 55,
    description: '만료 링크·멱등키 정리, 결과 미확인 결제 대사 큐, 고아 결제 종료, 전자서명 만료',
  },
  {
    name: 'events', path: '/api/cron/events', schedule: '1분마다', eventBridge: 'rate(1 minute)',
    // 잠금 TTL = 이벤트·저니 선점 유지(5분). 단계별 시간 상한(이벤트 60초 + 저니 90초 + 승인 실행 60초) 합이 이보다 짧다(점검 A-3).
    intervalSec: 60, lockTtlSec: 300,
    description: '도메인 이벤트 처리 — 기관 알림·명단 연결·목표 달성·저니 단계 실행, 승인된 일괄 발급 실행·멈춘 승인 복구',
  },
  {
    name: 'webhooks', path: '/api/cron/webhooks', schedule: '1분마다', eventBridge: 'rate(1 minute)',
    intervalSec: 60, lockTtlSec: 120,
    description: '실패한 파트너 웹훅 재전송(백오프)',
  },
  {
    name: 'alimtalk-reports', path: '/api/cron/alimtalk-reports', schedule: '5분마다', eventBridge: 'rate(5 minutes)',
    intervalSec: 300, lockTtlSec: 240,
    description: '알림톡 전달 결과 확인(솔라피) — 수신 완료 확정, 명시적 실패는 문자로 1회 대체, 2시간 무응답은 결과 미확인',
  },
  {
    name: 'outbound', path: '/api/cron/outbound', schedule: '1분마다', eventBridge: 'rate(1 minute)',
    intervalSec: 60, lockTtlSec: 55,
    description: '통합 발송 관리 — 기한 된 정보성 안내를 후원자별로 묶어 한 통으로 발송(7일 상한·야간·담당자 확인 보류), 멈춘 발송은 결과 미확인으로',
  },
  {
    name: 'content', path: '/api/cron/content', schedule: '1시간마다', eventBridge: 'cron(0 * * * ? *)',
    intervalSec: 3600, lockTtlSec: 900,
    description: '콘텐츠 자율 생성(캘린더)·멈춘 생성 재개·SNS 예약 게시·지표 수집',
  },
  {
    name: 'content-review', path: '/api/cron/content-review', schedule: '15분마다', eventBridge: 'rate(15 minutes)',
    intervalSec: 900, lockTtlSec: 300,
    description: '콘텐츠 승인 알림 — 월요일 09시 그 주 검토 대기 건수, 게시 시각 하루 전·3시간 전 미승인(같은 슬롯·시점 1회, 콘솔 알림)',
  },
  {
    name: 'recurring', path: '/api/cron/recurring', schedule: '매일 10:00', eventBridge: 'cron(0 1 * * ? *)',
    intervalSec: 86_400, lockTtlSec: 900,
    description: '정기후원 출금·실패 재시도·정지',
  },
  {
    name: 'payout', path: '/api/cron/payout', schedule: '매일 10:30', eventBridge: 'cron(30 1 * * ? *)',
    intervalSec: 86_400, lockTtlSec: 600,
    description: '지급일 도래 정산 이체',
  },
  {
    name: 'edoc', path: '/api/cron/edoc', schedule: '매일 03:00', eventBridge: 'cron(0 18 * * ? *)',
    intervalSec: 86_400, lockTtlSec: 600,
    description: '전자문서 정액 만료·서명 요청 만료·끝난 봉투 결과 대사·미사용 글꼴 정리',
  },
  {
    name: 'monthly-notice', path: '/api/cron/monthly-notice', schedule: '매월 1일 10:00', eventBridge: 'cron(0 1 1 * ? *)',
    intervalSec: 31 * 86_400, lockTtlSec: 1800,
    description: '월간 후원 안내, 매월 영수증 기관 영수증 발급',
  },
  {
    name: 'receipts', path: '/api/cron/receipts', schedule: '매일 09:00 (1~2월에만 일함)', eventBridge: 'cron(0 0 * * ? *)',
    intervalSec: 86_400, lockTtlSec: 1800,
    description: '연 1회 영수증 기관의 전년도 일괄 발급 준비(승인 대기함) — 승인된 건 발급',
  },
  {
    name: 'inbox', path: '/api/cron/inbox', schedule: '1시간마다', eventBridge: 'cron(20 * * * ? *)',
    intervalSec: 3600, lockTtlSec: 600,
    description: '승인 대기함 처리 기한 넘김 → 기관 대표 담당자 콘솔 알림(배정마다 1회), 처리된 항목의 배정 닫기',
  },
  {
    name: 'bazaar', path: '/api/cron/bazaar', schedule: '1시간마다(라이브 바자회 켜짐일 때만 일함)', eventBridge: 'cron(10 * * * ? *)',
    intervalSec: 3600, lockTtlSec: 600,
    description: '라이브 바자회 매칭 수락 기한 만료 → 기부 건을 접수 상태로 되돌림',
  },
];

export function cronDef(name: string): CronDef | undefined {
  return CRON_JOBS.find((j) => j.name === name);
}
