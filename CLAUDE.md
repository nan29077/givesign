# 기브싸인(GIVESIGN) — 개발 가이드

사회복지기관 전용 **MO 문자후원 서비스**. 기관마다 전용 수신번호(MO 번호)를 주고, 후원자는 그 번호로 문자 한 통을 보내 후원한다. 이 문서는 이 저장소에서 작업할 때의 규칙이다.

로컬 작업 폴더는 `E:\프로젝트\기브싸인`, 원격은 `github.com/nan29077/givesign` 다. 메시지페이(`E:\프로젝트\메시지페이`)를 복사해 만들었지만 **완전히 독립된 별개 서비스**다. 메시지페이 쪽 변경을 가져오거나 되돌려 보내지 않는다.

브랜드 표기는 한글 **기브싸인**, 영문 **GIVESIGN**, 식별자 슬러그 `givesign` 으로 통일한다. 코드·자산·시드·문서에 `messagepay` / `메시지페이` / `tornado` / `donaido` / `munjapay` / `문자페이` 를 다시 만들지 않는다.

식별자 체계: 시드 계정 도메인 `@givesign.kr`, 시드 비밀번호 `givesign1234!`, 기관 코드 `GIV-XXXX`, 거래번호 `TRD-`(브랜드 무관), 쿠키 `givesign_inquiry`·`givesign_session`·`givesign_social_*`, 서명 헤더 `x-givesign-signature`, 잠금 파일 `.givesign-server.lock`, 도커 프로젝트/컨테이너/DB/볼륨 `givesign*`.

구브랜드가 남아 있는 예외는 적용 이력이라 그대로 둔다:
- `prisma/migrations/20260819100000_init_tornado` 폴더명과 그 안의 SQL, 그리고 `prisma/migrations/**/*.sql` 안의 구브랜드 식별자(트리거 함수명 등). 바꾸려면 기존 SQL 을 고치지 말고 새 마이그레이션을 추가한다.
- `prisma/seed-version.mjs` 의 시드 버전 이력 주석.

## 절대 규칙

1. **이모지를 사용하지 않는다.** 아이콘은 lucide-react 라인 아이콘만 사용한다 (size 16~20, strokeWidth 1.6~1.7).
2. **실제 계약/키가 없는 외부 연동을 성공 처리하지 않는다.** 어댑터 인터페이스 + mock 구현으로만 처리하고, 화면에 mock 임을 명시한다. 홈택스(국세청) 전자제출도 마찬가지다 — 제출용 파일 생성까지만 하고 "전송 완료"를 꾸며 내지 않는다.
3. **결제 성공과 사후 처리(감사 문자·영수증·웹훅) 성공을 같은 상태로 취급하지 않는다.** 사후 처리 실패가 결제 결과를 바꾸지 않는다.
4. **문자 한 건이 여러 번 결제되는 상황을 최우선으로 방지한다.** (멱등성 4중 방어 — `docs/02_아키텍처.md`) 정기후원은 약정의 `cycleMonth` 와 `recurring:{id}:{cycleMonth}` 멱등키로 월 1회만 결제한다. 결과를 확인하지 못한 실행(`RecurringRun.PENDING`)은 멱등키를 지우지 말고 다음 배치에서 결제사 조회로 먼저 확정한다. 정기후원 결제 건은 `paymentMode = RECURRING`, `channel = RECURRING` 이며 후원자당 기관당 진행 중 약정은 1건이다(부분 유니크 인덱스).
5. **정산 원장(`settlement_ledger`)은 append-only.** DB 트리거로 UPDATE/DELETE 가 차단되어 있다. 정정은 반대분개로 처리한다.
6. **개인정보/금융정보는 해시 + 암호화 + 마스킹 3분리 저장.** 화면과 로그에는 마스킹된 값만 노출한다. 기부금영수증용 주민등록번호는 `residentNoEnc`(암호화) + `residentNoHash` + 뒷자리 마스킹만 저장하고, 복호화는 영수증 발급·국세청 명세 생성 지점에서만 한다. 원문을 로그·CSV 미리보기·화면에 내보내지 않는다.
7. `DIRECT_TRIGGER`(MO 수신 즉시 결제)는 `ALLOW_DIRECT_TRIGGER=true` 이면서 금융사 서면승인이 등록된 경우에만 사용한다. 기본값은 `CONFIRM_LINK`. 정기후원 자동 출금도 실결제사에서는 `ALLOW_RECURRING_DEBIT=true` 가 있어야 실행된다(mock 결제사는 무관). 배치 호출은 `CRON_SECRET` 이 필수이며 운영에서 비어 있으면 부팅을 거부한다.
8. **수수료는 부가세 포함 요율로 운영하고, 공급가액과 부가세는 항상 분리해 기록한다.**
   - 운영 기본은 `vatIncluded = true`. 원장에는 공급가액과 부가세를 나눠 남긴다.
   - 관리자 화면의 요율 입력·표시 단위는 **퍼센트**. 저장은 소수 문자열(`percentRate` / `percentToDecimalString`).
   - 정책 적용 여부는 `active` 가 아니라 `effectiveFrom` / `effectiveTo` 로 판단한다.
9. **기부금영수증은 결제 성공(PAID_STATUSES) 건만 합산하고, 환불된 건은 제외한다.** 이미 발급된 영수증 금액이 바뀌는 환불은 영수증을 `VOID` 처리하고 재발급한다. 발급 번호는 재사용하지 않는다. 발급은 기관의 공익법인 지정이 **관리자 확인(`designatedDoneeVerifiedAt`)** 되고 만료 전일 때만 가능하다. 영수증은 발급 당시 후원자 정보(주민번호 암호문 포함)를 스냅샷으로 가지며 홈택스 명세는 스냅샷으로만 만든다. 명세 CSV 내려받기는 비밀번호 재확인 + 사유 + 하루 횟수 제한 + 1회용 토큰을 거친다(`hometax-export-gate.ts`).
10. **캠페인별 모금액은 `charge.campaign_id` 기준으로 집계한다.** 별도 누적 컬럼을 캐시로 두더라도 원천은 항상 결제 건이다.

11. **자동화(발굴·안내) 규칙.** (`docs/2026-10-30_자동화_적용보고서.md`)
   - 외부 연동(알림톡·SNS 게시·전자서명·콘텐츠 생성)은 어댑터 + mock 이 기본이고 `ALIMTALK_ENABLED` `SOCIAL_PUBLISH_ENABLED` `ESIGN_ENABLED` 로 연다. 운영에서 켰는데 공급자가 mock 이면 부팅을 거부한다. mock 은 게시물 주소·지표·서명 완료를 만들어 내지 않는다.
   - 알림톡은 **정보성** 템플릿(`ALIMTALK_TEMPLATES`)만, 기관 채널이 관리자 확인(`ACTIVE`)이고 승인 코드가 있을 때만 보낸다. 실패하면 같은 본문을 문자로 대체하고 `mt_outbound_message.channel/fallback` 에 남긴다. 광고성(후원 권유) 발송 기능을 만들지 않는다. 결제 링크·인증번호는 문자로만 보낸다.
   - 문자 예약어 `정기·정기후원·약정 / 봉사·자원봉사` 는 결제 건을 만들지 않고 링크만 회신한다. 캠페인 키워드로 쓸 수 없다.
   - 월간 안내는 `notice_run (merchant, month)` + `notice_delivery (run, payer)` 로 한 번만. 수신 거부(`payer_merchant_link.notice_opt_out_at`)는 제외한다.
   - 콘텐츠는 항상 "AI 생성 콘텐츠" 표시, 모집등록번호가 없으면 승인 불가, 기본은 담당자 승인제. 게시는 `content_publish (item, platform)` 1회, 예약→게시 중 전환은 조건부 갱신으로 잡는다. 수혜자 실사진·실명을 쓰지 않는다.
   - 약정서·신청서(`agreement_document`)는 스냅샷 + SHA-256, 바꾸면 새 판(이전 판 보존). 스냅샷에는 마스킹 값만 넣는다.
   - 유입 경로는 `?src=&cid=` → `givesign_src` 쿠키(7일) → `charge.source/content_item_id`, 약정·봉사 신청에 기록한다. 원천은 각 테이블이다.

## 약관

약관 본문은 `prisma/terms-content.ts` 에 두고 시드로 넣는다. 개정할 때는 `TERMS_VERSION` 과 `TERMS_EFFECTIVE_FROM` 을 올리고 **이전 버전을 비활성화하지 않는다** — 현행본은 시행일로 고르고(`terms.ts`), 이전 버전에만 동의한 후원자는 다음 후원 확정 화면에서 재동의한다(`staleRequiredConsents`). 약관은 후원(기부) 서비스 기준이다. 상품·포인트 대금 표현을 다시 넣지 않는다.

## 기관 후원 회원 (후원페이지 로그인)

- `/donate/[code]/login`·`/signup`·`/my` 의 회원은 `DonorMember` 로, **기관마다 독립**이다. 같은 이메일로 기관마다 따로 가입하며 비밀번호·세션이 섞이지 않는다.
- 세션 쿠키는 기관 코드별(`givesign_donor_<코드>`)이고 세션 행에도 기관을 기록한다. 읽을 때 요청한 기관과 다르면 비로그인으로 본다(`getDonorMember`).
- 관리자·기관 담당자·통합 후원자 계정(`app_user`/`givesign_session`)과 섞지 않는다. 후원페이지의 로그인·마이페이지 링크는 항상 그 기관 회원 화면으로 보낸다.
- 회원 화면은 그 기관 후원만 보여 주고, 후원 내역 연결은 휴대폰 OTP 인증(`phoneHash`)으로만 한다. 같은 기관에서 한 번호는 한 회원만 인증할 수 있다.
- 통합 관리자는 `/admin/donor-members` 에서 전 기관 회원을 소속 기관과 함께 보고 정지·해제한다(감사로그). 기관은 `/studio/donors` 에서 자기 회원만 마스킹 이메일로 본다.
- 기관 로고는 `MerchantProfile.avatarUrl`(기관 정보 > 기관 로고) 하나로 관리하고 `OrgLogo` 로 그린다. 미등록이면 기본 캐릭터. 후원페이지 설정의 로고는 후원페이지에만 다른 로고를 쓸 때의 덮어쓰기다.

## 용어

화면·문구·주석 모두 이 용어를 쓴다.

| 옛 용어 (메시지페이) | 쓰는 용어 |
|---|---|
| 가맹점 / 크리에이터 | 기관 (사회복지기관) |
| 이용자 / 후원자 | 후원자 |
| 충전 / 결제 | 후원 (돈을 내는 행위) |
| 충전 상품 | 후원 항목 (지정후원 용도) |
| 충전 반영 / 포인트 지급 | 후원 처리 (기관이 확인·감사 처리) |
| 결제 페이지 `/c/[code]` | 후원 페이지 `/donate/[code]` (`/c/[code]` 는 호환 유지) |
| 가맹점 콘솔 | 기관 콘솔 (`/studio`) |
| 가맹 신청 | 기관 등록 신청 (`/merchant-apply`) |
| 상품 관리 | 후원 항목 관리 |
| — | 캠페인 (`Campaign`): 목표액·기간·용도가 있는 모금 단위 |
| — | 정기후원 (`RecurringDonation`): 매월 자동 출금 |
| — | 기부금영수증 (`DonationReceipt`): 연말정산용 발급 대장 |

DB 모델·테이블·컬럼은 메시지페이 것(`Charge` · `MerchantProfile` · `PayerProfile` · `merchantId` · `payerId`)을 **호환을 위해 그대로 쓴다.** 코드 식별자는 바꾸지 않고 화면 문구만 위 용어로 쓴다.

## 기관 콘솔 구조

| 메뉴 | 경로 | 맡는 것 |
|---|---|---|
| 대시보드 | `/studio` | 이달 후원액·후원자 수·정기후원·캠페인 진행률 |
| 후원 내역 | `/studio/charges` | 건별 후원 (MO·웹·정기) |
| 후원자 관리 | `/studio/donors` | 후원자별 누적·최근·정기 여부·메모·영수증 신청 |
| 정기후원 | `/studio/recurring` | 정기후원 현황·실패·해지 |
| 캠페인 | `/studio/campaigns` | 모금 단위 등록·진행률·문자 키워드 |
| 후원페이지 | `/studio/donation-page` | 공개 `/donate/[code]` 구성 |
| 기부금영수증 | `/studio/receipts` | 연도별 발급·일괄 발급·홈택스 제출 파일 |
| 기관 정보 | `/studio/profile` | 기관 유형·고유번호·대표자·지정기부금단체·모집등록번호 |
| 후원자·봉사자 | `/studio/supporters` | 통합 구성원·세그먼트·기관 명단 업로드·약정 미완료 재안내 (`/studio/donors` 는 후원자 상세 분석) |
| 자원봉사 | `/studio/volunteers` | 신청 승인·배정·활동 기록·1365 등록 자료 CSV (`FEATURE_VOLUNTEER`) |
| 약정서·신청서 | `/studio/agreements` | 전자 약정서·신청서 보관·판 이력 |
| 콘텐츠 만들기 / SNS 채널 | `/studio/content` · `/studio/channels` | 숏폼·캠페인 이미지 생성·승인·예약 게시 (`FEATURE_CONTENT`) |
| 알림톡·월간 안내 | `/studio/notices` | 카카오 채널·템플릿 코드, 월간 안내·영수증 주기 |
| QR 코드 | `/studio/qr` | 후원페이지 QR 1개 + 캠페인마다 QR (`/api/qr/[code]`, `/api/qr/[code]/campaigns/[id]`, PNG·SVG·인쇄). 승인 기관·그 기관 캠페인만, 주소에 `?src=qr` |
| 후원 설정 / 문자 관리 / 정산 관리 | 기존 유지 | |

실물 상품·배송 상품(`/studio/products` 의 PHYSICAL/DOCUMENT, `/studio/orders`)은 **코드는 유지하되 메뉴와 공개 화면에서 숨긴다.** 전자문서 서식·제출 관리(`/studio/documents`)는 별도 기관 업무로 항상 제공한다. `FEATURE_GOODS=true` 환경변수로만 다시 노출한다. 꺼져 있으면 후원 항목 관리는 DIGITAL(후원 항목)만 다루고, 실물·문서 생성은 서버 액션에서도 거절하며, `/studio/orders`는 404 다. 후원 건의 `pointStatus` 는 `initialPointStatus()`(기본 `SKIPPED`)로 정한다 — 후원에는 기관이 따로 지급할 것이 없다. 메시지페이의 "포인트 지급" 상태 기계는 `FEATURE_GOODS` 를 켠 기관의 디지털 상품에만 산다.

규칙:
- **배송지·문서 원문(`*Enc`)은 목록에서 자동 복호화하지 않는다.** 열람할 때마다 감사로그를 남긴다. 영수증용 주민번호도 같은 기준이다(`RECEIPT_RESIDENT_NO_VIEW`).
- 기관은 환불을 실행할 수 없고 **요청만** 한다 → 관리자 승인.
- 보관(soft delete)은 되돌릴 수 있게 만든다. 단방향 삭제를 만들지 않는다.
- 기관 콘솔에서 후원자 전화번호 원문을 보여 주지 않는다. 마스킹 번호와 표시 이름만 쓴다.

## 기술 스택

- Next.js 16 (App Router) / React 19 / TypeScript / Tailwind CSS v4
- Prisma 7 + PostgreSQL 16 (Amazon RDS / Aurora PostgreSQL 호환)
- Redis (ElastiCache) — 한도 카운터, 속도 제한
- Vitest (DB 통합 테스트)

## 디렉터리

```
prisma/            스키마, 마이그레이션, 시드
src/lib/           env, crypto, id, money, datetime, labels, logger, fundraising
src/server/        db, auth, adapters/*, services/*
src/app/           라우트 (공개 / donate / c / r / my / studio(기관 콘솔) / admin / api)
src/components/    ui(공용), layout, brand, public, my, studio, admin
tests/             핵심 흐름 통합 테스트
docs/              분석·설계 보고서, 운영 문서
```

## 2026-11-05 점검 조치로 생긴 규칙

상세: `docs/2026-11-05_점검조치완료보고서.md`.

- **시드는 둘로 나뉜다.** `prisma/seed-base.ts`(약관·전역 수수료/한도 정책·필수 설정 — 운영에서도 없는 것만 넣는다) + 로컬 샘플(계정·거래). 운영 시드는 기준 데이터만 넣고 끝난다. 스테이징 샘플 시드는 `SEED_ADMIN_PASSWORD`(12자 이상, 공개 기본값 금지)가 필수이고, `givesign1234!` 는 로컬 전용이다. 기준 데이터가 비면 관리자 대시보드 경고 + 부팅 로그 오류(`base-data-check.ts`).
- **테스트 환경 고지는 한 곳에서 판단한다.** `src/server/services/service-mode.ts` 의 `testModeNotice()`(결제·문자 어댑터 mock 또는 `SAFE_MODE`). 공개 푸터·기관 신청 폼·기관 대시보드 띠는 이 값일 때만 그린다. 문구를 하드코딩하지 않는다.
- **결과 미확인 건 복구.** `src/server/services/payment-recovery.ts` 정리 배치가 15분 지난 `REQUESTED/TIMEOUT` 결제 거래를 UNKNOWN(대사 큐)으로, 30분 지난 출금 전 고아(RECEIVED·세션 없는 PENDING_PIN)를 실패로 닫는다. 돈이 빠졌을 수 있는 건은 실패로 확정하지 않는다. 헥토 조회의 빈/모르는 상태값은 PENDING.
- **PIN 성공 코드.** 결제사가 mock 이 아니면 환경과 무관하게 `MOCK` 코드는 무효이고, `PAYMENT_PIN_SUCCESS_CODES` 가 비면 모든 PIN 콜백을 거절한다(`resolvePinSuccessCodes`).
- **상품 규칙은 콘솔·파트너 API 공용**(`src/server/services/product-rules.ts`): `FEATURE_GOODS` 꺼짐이면 DIGITAL 만, 금액 범위·0원 거절·종류 변경 거절·보관 상품 수정 거절·종류별 12개.
- **보관(soft delete) 대상 추가:** 웹훅(전송 이력 보존)·발송 템플릿·금칙어·공휴일·관리자 배너·공지(`archived_at`). 하드 삭제를 새로 만들지 않는다.
- **동시 실행 선점.** 월간 안내는 `notice_run.locked_at` 선점 + `notice_delivery` 를 발송 전에 `SENDING` 으로 먼저 만든다. 콘텐츠 생성 재개·게시 고착(`PUBLISHING` 30분)·크론 잠금은 모두 조건부 갱신·소유자 확인(`runCronJob`).
- **탈퇴.** 후원자 탈퇴 시 `payer_receipt_profile` 을 지우고 영수증 동의 철회를 기록한다. 탈퇴자 명의 영수증은 발급하지 않는다(발급된 영수증 스냅샷은 보존). 주민번호 해시는 유니크.
- **공용 `Button` 의 기본 `type` 은 `button`** 이다. 폼 제출 버튼은 `type="submit"` 을 명시한다.
- **사업자 표시 정보**는 `BUSINESS_*` 환경변수로 받고, 값이 없으면 그 줄을 숨긴다(지어내지 않는다).
- **비밀번호 재설정 메일·후원회원 이메일 인증은 메일 발송 연동이 없다.** 운영에서 재설정 링크는 로그에만 남는다. 연동 전에는 "메일로 보냈다"고 꾸미지 않는다.
- 공개 화면의 로컬 이미지(`/assets/**`, `/banners/**`)는 Next 이미지 최적화를 쓴다(배포 환경에 `sharp` 필요). 업로드·외부 주소만 원본(`image-src.ts`).

## 실행 방법

루트 배치 파일은 번호가 붙은 3개가 기본이고, 나머지는 `도구_` 접두사를 쓴다.

- **`1_미리보기실행.bat`** (또는 `npm run preview`) — 내장 DB(PGlite)로 실행. 앱 **3060**, 내장 DB 5463(`.givesign-pglite`).
- **`2_개발서버실행.bat`** — Docker PostgreSQL(5462) + Redis(6390). 처음에는 `도구_DB시작.bat` → `도구_최초설치.bat`.
- **`3_서버종료.bat`** — 남아 있는 서버 정리.
- **`도구_수정즉시반영.bat`** — HMR. 코드를 고치는 동안에는 이쪽을 쓴다.
- 공통 의존성 점검기는 `tools/ensure-deps.bat`. 이름과 위치를 바꾸지 않는다.
- `.env` 에 `NODE_ENV` 를 넣지 않는다.
- `src/app/error.tsx` 등 에러 바운더리에서 훅을 쓰지 않는다.
- 서비스 포트는 **3060** 으로 고정한다. 변경 시 package.json 의 dev/start, .env 의 PORT·APP_BASE_URL, 배치 파일, `tools/*.ps1` 을 함께 수정한다.

## 마이그레이션 주의

- 마이그레이션은 `prisma/migrations/` 에 시간순으로 쌓여 있다. 폴더명·SQL 은 적용 이력이므로 이미 올라간 것을 고치지 않는다.
- **기준선:** 메시지페이에서 가져온 마이그레이션 28개(`20260819…` ~ `20260918100000_document_product`)는 분리 과정에서 주석이 바뀌어 체크섬이 원본과 다르다. 운영 DB 가 없는 상태에서 `97e5d88` 시점을 기준선으로 확정했다(2026-10-29 점검 M-19). 이 저장소로 만든 DB 는 문제없고, 메시지페이 DB 에 이 마이그레이션을 적용하지 않는다. 이후로는 SQL 주석 하나도 손대지 않는다.
- 스키마를 바꾼 뒤에는 반드시 **빈 DB 에서 `npm run db:reset`** 으로 처음부터 적용되는지 확인한다.
- `prisma migrate reset` 대신 `npm run db:reset`(tools/db-reset.mjs)을 사용한다.

## 자주 쓰는 명령

```bash
npm run preview      # 내장 DB(PGlite)로 미리보기
npm run dev          # 개발 서버 (외부 PostgreSQL 필요)
npm run build        # 프로덕션 빌드
npm run typecheck    # tsc --noEmit
npm test             # Vitest (DB 를 비우므로 실행 후 db:seed 필요)
npm run db:migrate   # prisma migrate dev
npm run db:seed      # 시드 데이터
npm run db:reset     # 초기화 + 시드
```

## 공용 파일 수정 시 주의

`src/components/ui/index.tsx`, `src/lib/**`, `src/server/**`, `src/app/globals.css`, `prisma/schema.prisma` 는 전 화면이 공유한다. 변경 시 `npm run typecheck && npm test && npm run build` 를 모두 통과시킨다.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## 2026-10-30 추가 서비스

- 기관 배너·여백 프리셋 각 5종은 public/assets/givesign/presets/에 저장. 최초 기관별 무작위 배정을 SystemSetting에 저장하며 직접 선택·업로드가 우선한다.
- 메인 여백 5종과 선택값은 /admin/appearance에서 최고관리자가 관리한다.
- 신규 MO는 1588-1234-1234 형식. 저장 키는 숫자 12자리이며 과거 거래의 수신번호는 바꾸지 않는다.
- 전자문서 센터 /studio/e-documents, 이용요금 /studio/document-billing, 운영 /admin/e-documents, 서명 화면 /sign/[토큰]. 배치 /api/cron/edoc.

## 전자문서 (서명 요청 · 이용요금)

- 서명 요청은 `EDocEnvelope`(봉투) + `EDocSigner`(최대 5명, 동시/순차) 다. 발송 시점 서식을 암호화 스냅샷으로 고정한다. 첫 번째 서명자가 항목을 작성하고 나머지는 확인 후 서명한다.
- 서명자는 받은 번호로 문자 인증번호를 확인해야 내용을 본다. 서명 링크 토큰은 해시만 저장하고, 재발송하면 새 토큰을 만들어 이전 링크를 무효로 한다.
- 모든 사건은 `edoc_event` 에 append-only(DB 트리거)로 쌓이고 직전 해시를 잇는 해시 체인을 가진다(`verifyEnvelopeChain`). 공동인증서·공인전자문서 중계·TSA 는 연동하지 않았고 화면에도 그렇게 적는다.
- 이용요금 근거는 `edoc_ledger`(append-only, 멱등키 use:/refund:/topup:/bonus:/plan:/expire:/adjust:/trial:)다. `edoc_wallet` 은 캐시이며 `verifyWallet` 로 원장과 대조한다. 금액은 공급가액·부가세를 나눠 남긴다.
- 차감 순서: 30일 정액 제공량 → 시범 제공량 → 충전 잔액. 봉투 생성과 차감은 한 트랜잭션(지갑 FOR UPDATE). 아무도 열기 전 취소만 환원한다. 만료·거절은 환원하지 않는다.
- 요금제는 `EDocPlan` 버전으로 두고 `effectiveFrom` 으로 적용한다(지난 요금제는 고치지 않음). 충전·정액은 기관 신청 → 관리자가 입금 확인 체크 후 승인. 정액은 자동 갱신하지 않는다. 이용 잔액은 후원금·정산과 별개다.
- 기부금영수증은 전자서명 문서로 만들지 않는다. 영수증 대장(`/studio/receipts`)에서만 발급한다.
- 상세 범위와 테스트 환경 제한: docs/UPGRADE_20261030.md.

## 문서 서식 원본 편집 (파일 업로드 서식)

- 기관이 올린 서식(PDF·한글·워드·PNG/JPG 스캔본)은 업로드 때 편집 바탕 PDF(`basePdfUrl`)를 함께 만든다. PDF 는 원본 그대로, 그림은 한 쪽 PDF, 한글·워드는 `SOFFICE_PATH`(LibreOffice)가 있을 때만 변환한다. 없으면 PDF 로 저장해 올리도록 안내하고 내려받기 서식으로만 쓴다.
- **원본 PDF 는 고치지 않는다.** 수정은 `pdfLayout`(`@/lib/pdf-form` PdfLayout) 기록으로만 두고, 서버가 원본 위에 덮개 + 새 글자를 그려 결과 PDF(`renderedPdfUrl`)를 **새 파일로** 남긴다. 이전 결과 파일을 덮어쓰거나 지우지 않는다(발송된 서명 요청 스냅샷 `pdfUrl`/`pdfHash` 가 가리킨다).
- 글꼴은 ① 원본 글꼴 객체 재사용(ToUnicode 역매핑) ② 기관이 올린 같은 이름 글꼴 ③ 원본에 통째로 든 글꼴 ④ PDF 표준 글꼴 ⑤ 같은 계열·굵기 대체 글꼴(`assets/fonts`, Noto CJK KR 파생, OFL) 순으로 고른다. **글자 크기·색·방향은 항상 원본에서 읽은 값**이다. 대체 글꼴을 쓴 수정은 화면에 원인 글자와 함께 표시한다.
- 덮은 자리의 원래 글자는 내용 스트림에서도 지운다(`pdf-form/strip.ts`) — 복사·검색에 옛 값(약정 금액 등)이 남지 않게. 해석할 수 없는 쪽은 덮기만 하고 결과에 그 쪽을 알린다.
- 기관이 올린 글꼴(TTF·OTF)은 공개 주소로 서빙하지 않는다(`/api/media` 허용 확장자에 없음). 비공개 저장소(`putPrivateObject`: S3 `S3_PRIVATE_PREFIX`, 로컬 `var/private`)에 두고 `document_font_asset` 대장으로 기관 소유·한도(20개·150MB)를 관리하며, 렌더할 때 그 기관 글꼴만 읽는다. 쓰이지 않는 글꼴은 `/api/cron/edoc` 가 정리한다.
- 저장소 파일은 주소 문자열이 아니라 **객체 이름**으로 다룬다(`objectNameFromUrl` = `mediaUrl` 의 역함수, `S3_PUBLIC_BASE` 주소도 받는다). 덮개 아래 글자를 다 지우지 못했을 수 있는 쪽(폭 모르는 글꼴·양식 XObject)도 `coverOnlyPages` 로 알린다. 상세: docs/2026-11-05_점검_D_조치.md.
- `assets/fonts/*.ttf` 는 위치표를 긴 형식 + 글자 데이터 짝수 길이로 저장해 두었다. fontkit 의 부분집합 생성이 짧은 위치표에서 홀수 길이 글자를 깨뜨리기 때문이다. 글꼴을 바꾸면 같은 조건으로 다시 저장한다.
- **등록 화면에서 바로 미리보기·편집한다.** 파일을 올리면 같은 폼 안에 편집기(`DocumentFileEditorField` → `PdfFormEditor`)가 열리고, 편집 기록은 hidden `pdfLayoutJson` 으로 서식 등록·저장 때 함께 저장된다(`applyPdf`). 같은 기록이면 결과를 다시 만들지 않는다. 넓은 화면 편집 `/studio/documents/[id]/edit` 는 기록만 따로 저장한다.
- 서식 행이 생기기 전 미리보기·등록은 업로드 응답의 서명 토큰(`signBasePdf`, 기관·파일·24시간)으로 이 기관이 올린 바탕 PDF 인지 확인한다. 바탕 PDF 주소만으로는 미리보기·등록할 수 없다.
- **브라우저에서는 pdf.js 호환 빌드(`pdfjs-dist/legacy/build/*`)만 쓴다**(`src/components/pdf/pdfjs.ts`). 기본 빌드는 최신 브라우저 기능(`Map.getOrInsertComputed`)을 보완 없이 써서, 최신이 아닌 브라우저에서 미리보기가 안 보인다(2026-11-04 장애). `e2e/pdf-form-edit.mjs` 는 그 기능을 끈 브라우저(`--js-flags=--no-js-upsert`)로 돈다.
- API: 미리보기 `POST /api/studio/pdf-form/preview`({templateId} 또는 {basePdfUrl, token} + layout), 글꼴 올리기 `POST /api/studio/pdf-form/font`. 화면 흐름 확인 `node e2e/pdf-form-edit.mjs`.

## 자동 실행 계층 (2026-11-06 고도화)

- **도메인 이벤트(아웃박스).** 업무 트랜잭션 안에서 `emitDomainEvent(…, tx)` 로 `domain_event` 에 남긴다(`dedupe_key` 유니크). 결제 성공(`charge.paid`)은 승인·정산 원장과 같은 트랜잭션이다. 후속 일(알림·명단 연결·목표 달성·저니)은 소비자로만 붙인다 — `executePayment` 등 업무 함수에 후속 호출을 새로 하드코딩하지 않는다. payload 에 개인정보 원문을 넣지 않는다.
- 소비자는 `event-consumers.ts` `registerDefaultConsumers()` 에 등록하고 `/api/cron/events`(1분)가 (이벤트, 소비자) 1회 처리한다. 실패 소비자만 백오프 재시도, 6회 소진 시 FAILED(관리자 자동화 > 배치·이벤트에서 재처리).
- **배치는 `src/server/cron-registry.ts` 에 선언**하고 라우트는 공용 `runCronJob`(인증·소유자 잠금·`cron_heartbeat` 실행 기록)만 쓴다. 잠금을 직접 구현하지 않는다. 수신 배치(emma-mo)만 `failOpenLock`.
- **승인 요청(`approval_request`).** "시스템이 준비하고 사람이 승인" 하는 일은 `requestApproval` + `registerApprovalHandler(kind)` 로 만든다. 결정은 PENDING→PROCESSING 조건부 선점, 처리기 실패 시 PENDING 으로 되돌림.
- **저니(`src/server/services/journeys`).** 정의는 코드에 고정(광고성 단계 없음), 기관은 `/studio/journeys` 에서 켜기·단계별 '승인 후 보내기'·값만 바꾼다. 실행은 (저니, 이벤트) 유일. 발송 단계 공통 보호: 탈퇴·차단·`notice_opt_out_at` → 멈춤, 야간 21~9시 KST → 다음 날 9시(`JOURNEY_QUIET_HOURS=off` 로만 끔), 후원자당 7일 3건 상한 → 하루 보류(14번 넘으면 건너뜀). 문서 단계는 `issuePurposeDocument` 만 부른다.
- **영수증 연간 준비.** `receiptCycle=YEARLY` 기관은 1~2월 `/api/cron/receipts` 가 발급 가능자를 승인 요청(RECEIPT_BATCH, 주 1회·대기 중이면 새로 안 쌓음)으로 올리고, 미등록자에게는 `receipt.info_needed` → 저니가 등록 방법을 안내한다. 발급은 담당자 승인 후에만.
- **통합 승인 대기함(`/studio/inbox`).** 승인 요청 + 콘텐츠 검토 + 봉사 신청 + 제출 문서 + 신고를 원천 테이블에서 모은다(복사하지 않음). 자동화 준비도(`automationReadiness`)는 같은 화면 위쪽에 — 빠진 항목이 무엇을 멈추는지 적는다.

## 용도별 자동 발송 문서 (2026-11-06)

- 서식(`DocumentTemplate`)에 `purpose`(`purpose-documents.ts` `DOCUMENT_PURPOSES`)·`autoSend`·`defaultSet` 이 있다. 기관×용도마다 **보관 전 서식 1개**(부분 유니크 인덱스 `document_template_merchant_purpose_one`). 중지(`active=false`)나 `autoSend=false` 면 그 용도는 보내지 않는다(`blocked: 'DISABLED'`).
- 기본 세트(`DOCUMENT_PRESETS` 의 `purpose`: 약정서·봉사 신청서·활동 확인서·변경 신청서·감사장 4종)는 `ensureDefaultPurposeTemplates`(`purpose-templates.ts`)가 기관 PRESET 서식으로 복사한다. 멱등·동시 호출 안전(P2002 = 이미 있음), 같은 presetKey 의 용도 없는 서식은 새로 만들지 않고 용도만 붙인다. 기관 승인 시점 + `issuePurposeDocument` 첫 호출 때 부른다. **운영 시드에는 넣지 않는다**(로컬 샘플 시드만). 기본 세트 서식은 서식 개수 상한에 넣지 않는다.
- 머지 필드 `{{후원자명}}` 등은 `src/lib/merge-fields.ts` 하나로 처리한다(`MergeContext` ↔ `mergeValuesFromContext`). 값이 없으면 빈칸 + `missing`, 모르는 이름은 그대로 두고 미리보기에서 경고, 값 안의 전화·주민번호 꼴은 마스킹, HTML 로 그릴 때는 본문·값 모두 이스케이프(`renderMergeHtml`). 파일 서식은 편집 기록의 새 글자에 치환해 **새 PDF** 를 만든다(`renderMergedTemplatePdf` — 원본·서식 결과 PDF 불변, 열람 문서는 비공개 저장소). 기관이 직접 보내는 서명 요청에도 기관명·대표자·발급일·서명자 이름은 채운다.
- 저니·소비자는 `issuePurposeDocument` 만 부른다(계약은 `purpose-documents.ts`, 구현은 `issued-documents.ts`). 서명 불필요 용도는 `issued_document` + 열람 토큰(해시만, 30일) → `/l/[토큰]`(noindex·인쇄, 만료 후 `/my/documents`), 안내는 `tplDocumentIssued`. 서명 필요 용도(`SUPPORT_AGREEMENT·VOLUNTEER_APPLICATION·RECURRING_CHANGE`)는 `createEnvelope`(서명자 1명=후원자, actor `system`, 이용요금 차감 그대로, 봉투 id 는 dedupeKey 에서 결정)로 보내고 잔액이 없으면 `blocked: 'EDOC_BALANCE'`. 탈퇴 후원자는 `WITHDRAWN`. 같은 `dedupeKey` 는 한 번(`already: true`, link null).
- 약정서·신청서(`agreements.ts`)는 기관 용도 서식 본문을 머지한 결과를 스냅샷 `form` 에 고정한다(기존 스냅샷 필드·해시·판 규칙 그대로). `ESIGN_PROVIDER=internal` 이면 전자문서 센터 봉투로 서명을 받고(`agreement_document.esign_request_id = edoc_envelope.id`, 발송 키 `agreement:{약정서 id}`), 봉투가 끝나면 `syncIssuedFromEnvelope` → `completeESign` 으로 반영한다(edoc 완료 지점에서 직접 + `document.signed` 소비자 `purpose-document-sign` 로 재확인). internal 은 mock 이 아니라 운영 부팅 점검을 통과한다.
- 콘솔: `/studio/documents?tab=purposes`(용도별 현황), `/studio/documents/issued`(발급 목록·재발송·보관). 후원자: `/my/documents`. 기부금영수증은 이 기능으로 만들지 않는다(연말 감사장은 별도 용도, "영수증이 아님" 을 적는다).
