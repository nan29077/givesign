# 기브싸인 AWS 실서버 배포 가이드

- 대상: Amazon RDS / Aurora PostgreSQL 16 + ECS(Fargate) 또는 Elastic Beanstalk + ElastiCache(Redis) + S3
- 전제: 2026-08-21 검수 반영 이후 코드 기준

---

## 1. DB — 형식은 이미 맞춰져 있습니다

로컬과 운영이 **같은 엔진(PostgreSQL 16)** 이고, RDS 에서 못 쓰는 기능을 하나도 사용하지 않습니다.
이관 시 스키마를 다시 짤 필요가 없습니다.

| 항목 | 상태 |
|---|---|
| DB 엔진 | PostgreSQL 16 (로컬·운영 동일) |
| `CREATE EXTENSION` 의존 | **0건** — RDS 는 확장 설치가 제한되는데 하나도 쓰지 않습니다 |
| 시각 컬럼 | 127개 전부 `timestamptz` (naive timestamp 0건) |
| 금액 | `BIGINT` (원 단위 정수). 부동소수점 0건 |
| 요율 | `NUMERIC(10,6)` |
| ID 생성 | 앱에서 ULID 생성 → `gen_random_uuid()` 등 DB 함수 의존 없음 |
| 서버 타임존 | 무관. 화면 시각은 `formatKst()` 가 +9h 오프셋으로 계산 |
| 커넥션 풀러 | `pg_advisory_xact_lock` (트랜잭션 스코프) → RDS Proxy·PgBouncer 호환 |

### 마이그레이션 실행

```bash
# 운영 배포 시 (풀러를 거치지 않는 직결 엔드포인트로 실행할 것)
DIRECT_DATABASE_URL="postgresql://...rds.amazonaws.com:5432/givesign?sslmode=require" \
  npx prisma migrate deploy
```

`prisma.config.mjs` 는 `DIRECT_DATABASE_URL` 이 있으면 그것을 우선 사용합니다.
`DATABASE_URL` 을 RDS Proxy 로 잡아둔 상태에서 마이그레이션을 돌리면
DDL + advisory lock 조합이 트랜잭션 풀링과 충돌해 실패하거나 중간에 멈춥니다.

### 배포 전 드리프트 검사 (CI 에 넣을 것)

```bash
SHADOW_DATABASE_URL="postgresql://user:pw@host:5432/givesign_shadow" \
  npx prisma migrate diff \
    --from-migrations prisma/migrations \
    --to-schema prisma/schema.prisma \
    --exit-code
# 종료코드 0 = 일치, 2 = 불일치(배포 중단)
```

스키마와 마이그레이션이 어긋난 채로 `migrate dev` 를 돌리면
**기존 인덱스를 DROP 하는 마이그레이션이 자동 생성**됩니다. 운영 DB 에서 발견하면 늦습니다.

---

## 2. DB 역할(롤) 분리 — 회계 무결성의 전제

`settlement_ledger` 는 트리거로 UPDATE/DELETE 를 막고 있습니다. 그런데
**테이블 소유자는 `ALTER TABLE ... DISABLE TRIGGER` 로 이 보호를 해제할 수 있습니다.**
앱이 마이그레이션까지 같은 롤로 돌리면 앱 롤이 곧 소유자가 되어 보호가 사실상 무력해집니다.

RDS 에서 아래처럼 분리하십시오. (감사 대응에도 이 분리가 필요합니다)

```sql
-- 1) 마이그레이션 전용 롤 (스키마 소유자). CI/배포 파이프라인만 사용
CREATE ROLE givesign_migrate LOGIN PASSWORD '...';
GRANT ALL ON SCHEMA public TO givesign_migrate;
ALTER SCHEMA public OWNER TO givesign_migrate;

-- 2) 앱 런타임 롤 (DML 만). 애플리케이션이 사용
CREATE ROLE givesign_app LOGIN PASSWORD '...';
GRANT USAGE ON SCHEMA public TO givesign_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO givesign_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO givesign_app;
ALTER DEFAULT PRIVILEGES FOR ROLE givesign_migrate IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO givesign_app;

-- 3) 원장은 앱 롤에서 INSERT/SELECT 만 허용 (트리거와 이중 방어)
REVOKE UPDATE, DELETE ON settlement_ledger FROM givesign_app;
```

- `DATABASE_URL` → `givesign_app`
- `DIRECT_DATABASE_URL` → `givesign_migrate`

---

## 3. 이미지 저장소 — S3 전환이 필수입니다

기본값 `STORAGE_DRIVER=local` 은 **단일 서버에서만** 성립합니다. AWS 에서는:

- 인스턴스를 2대 이상 띄우면 A에 올린 이미지가 B 요청에서 404
- 재배포·오토스케일 축소 시 컨테이너 파일시스템과 함께 **이미지 전량 소실**

```bash
STORAGE_DRIVER=s3
S3_BUCKET=givesign-media-prod
S3_PREFIX=uploads
S3_PUBLIC_BASE=https://media.givesign.kr   # CloudFront 도메인 (선택, 없으면 /api/media 경유)
AWS_REGION=ap-northeast-2
```

부팅 점검(`assertBootSafety`)이 운영 환경에서 `STORAGE_DRIVER != s3` 를 잡아 **기동을 중단**시킵니다.
S3 권한은 태스크 역할(IAM Role)로 부여하고, 액세스 키를 환경변수에 넣지 마십시오.

필요한 최소 권한: `s3:PutObject`, `s3:GetObject` (해당 prefix 한정)

---

## 4. 컨테이너 빌드

```dockerfile
# 빌드 단계
ENV NEXT_OUTPUT=standalone
RUN npm ci && npx prisma generate && npm run build

# 실행 단계
CMD ["node", ".next/standalone/server.js"]
```

`NEXT_OUTPUT=standalone` 을 준 빌드만 standalone 출력이 됩니다.
로컬 미리보기(`npm run build && npm run start`)는 이 변수를 주지 않으므로 지금까지와 동일하게 동작합니다.
(standalone 빌드는 `next start` 로 실행할 수 없습니다)

---

## 5. 필수 환경변수 점검표

부팅 시 `assertBootSafety()` 가 아래를 검사하고, 하나라도 어긋나면 **기동을 중단**합니다.
조용히 잘못된 설정으로 서비스가 뜨는 것이 가장 위험하기 때문입니다.

| 변수 | 운영 값 | 왜 |
|---|---|---|
| `APP_ENV` | `prod` | 로컬 전용 기능(테스트 로그인, MO 시뮬레이터) 차단 |
| `APP_BASE_URL` | `https://...` | 결제 콜백 해시 재료 |
| `CRYPTO_PROVIDER` | `aws-kms` | 개인정보 봉투암호화 |
| `AWS_KMS_KEY_ID` | KMS 키 ARN | |
| `SESSION_SECRET` | 랜덤 32B | 기본값이면 세션 위조 가능 |
| `PHONE_HASH_SECRET` | 랜덤 32B | 기본값이면 전화번호 해시 충돌·역산 위험 |
| `ALLOW_INMEMORY_FALLBACK` | `false` | Redis 장애를 조용히 삼키면 한도·멱등성이 무력화됨 |
| `REDIS_URL` | ElastiCache 엔드포인트 | 오버레이 pub/sub·한도 카운터 |
| `STORAGE_DRIVER` / `S3_BUCKET` | `s3` / 버킷명 | 위 3번 |
| `MO_ALLOWED_IPS` | MTONET 발신 IP | 비면 웹훅 위조 가능 |
| `MO_WEBHOOK_SECRET` | 발급 값 | |
| `PAYMENT_PROVIDER` | `hecto` | mock 이면 가짜 성공 처리 |
| `HECTO_AUTH_UI_BASE` | `https://ezauth.settlebank.co.kr` | 결제창 |
| `HECTO_AUTH_API_BASE` | `https://ezauthapi.settlebank.co.kr:8081` | 서버 API — **UI 와 절대 합치지 말 것** (합치면 승인 전건 실패) |

---

## 6. 인프라 구성 권장값

| 항목 | 권장 |
|---|---|
| RDS | PostgreSQL 16, Multi-AZ, 자동 백업 7일 이상, `sslmode=require` |
| RDS Proxy | 앱 → Proxy(`DATABASE_URL`), 마이그레이션 → 직결(`DIRECT_DATABASE_URL`) |
| DB_POOL_MAX | 인스턴스당 10 (기본값). RDS `max_connections` ÷ 인스턴스 수 안쪽으로 |
| ElastiCache | Redis, 클러스터 모드 비활성 + 복제본 1 |
| ALB 헬스체크 | `/api/health` (200/503). 읽기 전용 점검이라 쓰기 부하 없음 |
| 로그 | CloudWatch Logs. 앱은 JSON 한 줄 로그로 출력 |
| 시크릿 | AWS Secrets Manager → 태스크 정의에서 주입. 이미지에 넣지 말 것 |

---

## 7. 배포 순서

1. `SHADOW_DATABASE_URL` 로 드리프트 검사 (불일치면 중단)
2. `DIRECT_DATABASE_URL` 로 `prisma migrate deploy`
3. `NEXT_OUTPUT=standalone npm run build` → 이미지 푸시
4. ECS 서비스 롤링 배포 (기동 시 `assertBootSafety()` 통과 여부가 곧 헬스체크)
5. `/api/health` 를 관리자 계정으로 열어 `providers` 가 전부 실제 연동인지 확인
