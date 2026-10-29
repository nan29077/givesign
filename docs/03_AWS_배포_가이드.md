# AWS 배포 가이드

이 프로젝트는 처음부터 **Amazon RDS / Aurora PostgreSQL** 을 목표로 설계되었습니다. 로컬 PostgreSQL 16 에서 개발하고, 동일 스키마를 그대로 AWS 에 올릴 수 있습니다.

---

## 1. 데이터베이스

### 권장 구성
- **Aurora PostgreSQL 호환** (또는 RDS PostgreSQL 16), ap-northeast-2
- Multi-AZ, 자동 백업 + PITR, 저장 암호화(KMS)
- 읽기 리플리카 1대 (관리자 통계·리포트용)
- **RDS Proxy** 경유 (Next.js 다중 인스턴스의 커넥션 폭주 방지)

### 설계상 이미 지켜진 호환 규칙
| 규칙 | 이유 |
|---|---|
| ID 는 애플리케이션에서 생성 (ULID) | `gen_random_uuid()` 등 DB 함수 의존 제거 → 리플리카/샤딩 안전 |
| 모든 시각은 `timestamptz`, UTC 저장 | 리전·서머타임 무관. 표시 시점에만 KST 변환 |
| 금액은 `BIGINT`(원 단위 정수) | 부동소수점 오차 제거 |
| 요율은 `NUMERIC(10,6)` | 정확한 수수료 계산 |
| RDS 미지원 확장 사용 안 함 | `pgcrypto`, `pg_trgm`, `citext`, `pgaudit` 범위 내에서만 |
| 컬럼 암호화는 애플리케이션 레이어 | 키를 DB 에 두지 않음 → KMS 봉투암호화로 전환 가능 |
| 테이블/컬럼 `snake_case` | DBA 인수인계 |

### 접속 문자열
```env
DATABASE_URL="postgresql://givesign:***@givesign.cluster-xxxx.ap-northeast-2.rds.amazonaws.com:5432/givesign?schema=public&sslmode=require&connection_limit=10"
# 마이그레이션은 Proxy 를 우회한다
DIRECT_DATABASE_URL="postgresql://givesign:***@givesign.cluster-xxxx.ap-northeast-2.rds.amazonaws.com:5432/givesign?schema=public&sslmode=require"
```

### 파티셔닝 (운영 전환 시)
대용량 로그 테이블은 월 단위 선언적 파티셔닝을 권장합니다. Prisma 는 파티셔닝을 직접 표현하지 못하므로 **별도 SQL 마이그레이션**으로 적용합니다.

대상: `mo_inbound_message`, `mt_outbound_message`, `webhook_log`, `overlay_event`

```sql
-- 예: webhook_log 를 created_at 기준 월 파티션으로 전환
BEGIN;

ALTER TABLE webhook_log RENAME TO webhook_log_old;

CREATE TABLE webhook_log (LIKE webhook_log_old INCLUDING ALL)
  PARTITION BY RANGE (created_at);

CREATE TABLE webhook_log_2026_09 PARTITION OF webhook_log
  FOR VALUES FROM ('2026-09-01Z') TO ('2026-10-01Z');
CREATE TABLE webhook_log_2026_10 PARTITION OF webhook_log
  FOR VALUES FROM ('2026-10-01Z') TO ('2026-11-01Z');
-- 기본 파티션(누락 방지)
CREATE TABLE webhook_log_default PARTITION OF webhook_log DEFAULT;

INSERT INTO webhook_log SELECT * FROM webhook_log_old;
DROP TABLE webhook_log_old;

COMMIT;
```

> 파티션 생성은 `pg_cron`(RDS/Aurora 지원) 또는 EventBridge + Lambda 로 매월 자동화하십시오.
> 보관주기: `webhook_log` 90일, `mo_inbound_message` / `mt_outbound_message` 는 전자금융거래 기록 보존 의무에 따라 법무 검토 후 결정(통상 5년).

### 무결성 가드 (이미 마이그레이션에 포함)
`prisma/migrations/*_guards_and_indexes/migration.sql`
- `settlement_ledger` **append-only 트리거** (UPDATE/DELETE 차단)
- 금칙어 전역/사회복지기관 **부분 유니크 인덱스** (NULL 우회 방지)
- 사회복지기관당 활성 코드 1개, 활성 스트림 키 1개
- 후원자당 활성 결제수단 1개
- 결제 건당 승인 결제 1건 (`payment_transaction_approved_uniq`)
- 금액 양수 CHECK 제약

---

## 2. 애플리케이션

### 권장 구성
- ECS Fargate 또는 App Runner (컨테이너), ALB + WAF
- 최소 2 태스크(AZ 분산), 헬스체크 `GET /api/health`
- **SSE 사용**: ALB idle timeout 을 60초 이상으로, 스티키 세션은 불필요(Redis Pub/Sub 로 브로드캐스트)
- CloudFront (정적 자산) + S3 (생성형 이미지 에셋)

### 워커 분리 (2단계 이후)
결제 재시도, 유튜브 전송 큐, MT 재발송, 정산 배치는 웹 프로세스와 분리된 **BullMQ 워커**로 실행하십시오. 현재는 요청 스레드 내에서 순차 처리합니다.

---

## 3. Redis (ElastiCache)

용도: 한도 카운터 캐시, 속도 제한, 로그인 브루트포스 방어, 유튜브 할당량 카운터, 오버레이 Pub/Sub.

```env
REDIS_URL="rediss://givesign-cache.xxxx.ng.0001.apn2.cache.amazonaws.com:6379"
ALLOW_INMEMORY_FALLBACK="false"   # 운영에서는 반드시 false
```

---

## 4. 비밀 관리

모든 키는 **AWS Secrets Manager** 또는 SSM Parameter Store 에서 주입합니다. 소스코드·이미지·로그에 하드코딩하지 않습니다.

```env
CRYPTO_PROVIDER="aws-kms"
AWS_REGION="ap-northeast-2"
AWS_KMS_KEY_ID="arn:aws:kms:ap-northeast-2:...:key/..."
```

KMS 전환 시 `@aws-sdk/client-kms` 를 설치하고 부팅 시점에 `setCryptoProvider()` 로 구현을 주입하십시오(`src/lib/crypto.ts`). 주입 없이 `aws-kms` 로 설정하면 **의도적으로 예외를 던져** 평문 저장을 막습니다.

> **키 로테이션 주의**: `PHONE_HASH_SECRET` 은 검색 키이므로 변경 시 기존 해시가 무효화됩니다. 로테이션이 필요하면 신규 해시 컬럼 병행 → 백필 → 전환 순서로 진행하십시오.

---

## 5. 운영 전환 체크리스트

`GET /api/health` 의 `productionWarnings` 가 비어 있어야 합니다.

- [ ] `APP_ENV=prod`
- [ ] `CRYPTO_PROVIDER=aws-kms` + KMS provider 주입
- [ ] `SESSION_SECRET`, `PHONE_HASH_SECRET`, `CRYPTO_MASTER_KEY` 를 운영 값으로 교체
- [ ] `ALLOW_INMEMORY_FALLBACK=false`
- [ ] `MO_ALLOWED_IPS` 에 사업자 IP 등록, `MO_WEBHOOK_SECRET` 운영 값
- [ ] `PAYMENT_PROVIDER=hecto` + 사회복지기관 키 (MID / 라이선스 / AES / HASH)
- [ ] `MT_PROVIDER` 실 사업자 + 발신번호 사전등록 완료
- [ ] `YOUTUBE_PROVIDER=google` + OAuth 동의화면 검증 완료 + **할당량 증설 승인**
- [ ] `SAFE_MODE=false` (이 전까지는 실제 결제·문자가 차단됨)
- [ ] `ALLOW_DIRECT_TRIGGER` 는 금융사 서면승인 등록 전까지 `false` 유지
- [ ] `/api/dev/outbox` 라우트 제거 또는 `APP_ENV` 가드 확인
- [ ] `/mock/**` 라우트 제거 (실 결제창·구글 동의화면으로 대체)
- [ ] `/admin/simulator` 차단 확인 (`APP_ENV=prod` 이면 자동 차단)
- [ ] 관리자 2단계 인증 활성화 (현재 스키마에 `twoFactorSecret` 필드만 준비됨 — 5단계 구현 대상)
- [ ] CloudWatch 알람: 결제 실패율, `UNKNOWN` 결제 건수, 유튜브 전송 실패율, Webhook 서명 실패

---

## 6. 모니터링 지표

| 지표 | 임계값(안) | 조치 |
|---|---|---|
| 결제 `UNKNOWN` 건수 | 1건 이상 | 즉시 수동 확인 |
| 결제 실패율 | 10% 초과 | PG 상태 점검 |
| Webhook 서명 실패 | 5분 내 5건 | 침입 시도 의심, IP 확인 |
| 유튜브 할당량 사용률 | 80% 초과 | 전송 상한 조정 / 증설 신청 |
| MT 발송 실패율 | 5% 초과 | 사업자 장애 확인 |
| 정산 원장 트리거 예외 | 1건 이상 | 원장 변경 시도 — 즉시 감사 |
