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
   - **콘텐츠 캘린더**(`content-calendar.ts`, `/api/cron/content`)는 (기관, 슬롯 시각) 유니크(`content_slot`)로 슬롯당 1건만 만든다. 모집등록번호·진행 중 캠페인·월 한도가 없으면 만들지 않고 이유를 설정 화면에 보인다(행으로 남기지 않음). 자동 승인은 승인까지만, 게시 예약은 `autoSchedule` + 슬롯이 미래 + `SOCIAL_PUBLISH_ENABLED` + 연결 채널·형식 허용일 때만 슬롯 시각으로 한다.
   - **LLM**(`adapters/llm`, `LLM_PROVIDER=mock|anthropic|openai`)은 JSON 응답을 검증(장면 수·자막 길이·해시태그·금지어·전화/이메일·링크)하고 어기면 1회 재요청 후 실패한다. 진행률·참여 방법·"AI 생성 콘텐츠"·모집등록번호·링크는 LLM 이 아니라 시스템이 붙인다. 키가 없으면 호출하지 않는다. 비용은 시도마다 `ai_usage`(실패 시도 포함). 프롬프트·응답 본문은 로그에 남기지 않는다.
   - **AI 초안**(`ai-drafts.ts` — 캠페인·감사 문구·문의 답변·성과 요약)은 입력칸을 채우기만 한다. 자동 저장·자동 발송·자동 게시를 만들지 않는다. 기관(관리자)당 분당 `AI_DRAFT_PER_MINUTE` 회. LLM 이 mock 이면 화면은 버튼 대신 "AI 공급자 연결 후 사용". 공급자로 보내는 문의 본문은 연락처·계좌를 가린다(`maskForLlm`). 수혜자 실명·연락처 패턴은 거절한다.
   - 영상(mp4)은 `FFMPEG_PATH` + sharp 가 있을 때만 조립해 `content_item.video_url` 에 둔다. TTS 는 계약 전이라 만들지 않는다(만든 척하지 않음). 플랫폼별 캡션 규칙은 `content-captions.ts` 한 곳(링크·AI 표시는 잘리지 않는다).

## 자원봉사 모집 공고·회차 (2026-11-06)

- 공고 `volunteer_posting`(DRAFT·OPEN·CLOSED·ARCHIVED, 모집 기간 KST 양끝 포함) + 회차 `volunteer_shift`(KST 날짜 + "HH:MM", `starts_at/ends_at` UTC 함께 저장, 하루를 넘기지 않음). 공개 후원페이지에는 OPEN 이면서 모집 기간 안인 공고만 보인다. 지우지 않고 보관한다.
- 회차 정원은 `applied_count < capacity` 조건부 증가(행 단위 원자 갱신)로만 지킨다. 철회·반려 때 같은 트랜잭션에서 되돌린다. 정원은 신청 수보다 작게 줄일 수 없고, 진행 중 신청이 있는 회차는 보관하지 않는다(보관은 회차 행 잠금 트랜잭션).
- 진행 중 신청 유니크: 일반 신청(회차 없음)은 기관당 1건(`volunteer_application_live_uniq`), 회차 신청은 (기관, 후원자, 회차) 1건(`volunteer_application_shift_live_uniq`).
- 마감·기간 밖 공고, 시작한 회차, 보관 회차에는 신청을 거절한다. 회차가 있는 공고는 회차를 골라야 한다.
- 승인 시 배정 안내를 비우면 "M/D(요일) HH:MM~HH:MM · 장소" 로 채운다(`shiftScheduleLabel`). 출석 → 회차 길이만큼 활동 기록 + `COMPLETED`(조건부 전환으로 1회), 불참 → `NO_SHOW`. 회차 시작 시각 전에는 처리하지 않는다.
- D-1 안내 대상은 `volunteerShiftsStartingOn(dateKey)`(발송하지 않음, 저니가 보낸다).
- 콘텐츠 짧은 링크 `/go/[publishId]` 는 `content_publish.clicks` 를 센다(봇 UA 제외, 같은 IP·게시 10분 1회 — IP 는 HMAC 키로만, IP 를 모르면 UA HMAC). 이동 주소는 게시 행에서 서버가 만든다(쿼리로 받지 않음).
- 후원자 병합(`/admin/payers/[id]`, 감사로그 `PAYER_MERGE`/`PAYER_UNMERGE`, 근거 필수)은 `payer_profile.merged_into_id` 표시만 한다. 결제·약정·봉사·영수증 행은 옮기지 않고 통합 구성원·후원자 누적에서만 합산한다. 1단계만, 순환 금지(두 행 FOR UPDATE). 영수증은 각자 명의. 기관 콘솔은 "병합됨" 표시만.

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
| 자원봉사 모집 공고 | `/studio/volunteers/postings` · `/studio/volunteers/postings/[id]` | 공고 등록·수정·모집 시작/마감·보관, 회차(날짜·시각·정원) 추가/보관, 회차별 신청 현황·출석/불참. 공개 `/donate/[code]/volunteer/[postingId]` |
| 약정서·신청서 | `/studio/agreements` | 전자 약정서·신청서 보관·판 이력 |
| 콘텐츠 만들기 / SNS 채널 | `/studio/content` · `/studio/channels` | 숏폼·카드뉴스·피드 이미지 생성·승인·예약 게시, 콘텐츠 캘린더(자율 생성)·성과 요약 (`FEATURE_CONTENT`). 채널: 유튜브·인스타그램·페이스북·틱톡·네이버 블로그·카카오 채널 |
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
- **비밀번호 재설정 메일·후원회원 이메일 인증은 메일 공급자가 실연동(`MAIL_PROVIDER=ses` + 키, `mailIsLive()`)일 때만 메일로 보낸다**(2026-11-06 7단계). 아니면 예전처럼 보내지 않고 "메일로 보냈다"고 꾸미지 않는다. 실연동이면 재설정 링크를 로그·콘솔·화면에 남기지 않는다.
- **7단계 외부 연동**(`docs/2026-11-06_외부연동_설정가이드.md`): SNS 계정 연결은 OAuth(`/api/studio/social/<platform>/connect·callback`, state HMAC 서명·10분·세션 기관 일치, 구글 PKCE), 토큰은 `social_channel.*_enc` 암호화만. 유튜브는 항상 비공개 업로드 후 담당자가 공개 전환, 틱톡은 SELF_ONLY. 네이버 블로그·카카오 채널은 공개 게시 API 가 없어 내려받아 직접 게시. 알림톡 실공급자는 솔라피(`coolsms`, 공급자 대체 문자 끔 → 실패 시 우리 문자 대체).
- **2026-11-06 정밀 점검 조치(콘텐츠·SNS·알림톡·봉사)** (`docs/2026-11-06_후원자동화_라이브바자회_정밀점검보고서.md` A-5·A-M8~A-M13):
  - 알림톡 접수(솔라피 2000)는 성공이 아니다. `mt_outbound_message.status=ACCEPTED`(`delivery_status` 에 `ACCEPTED`·`UNKNOWN`)로 두고 `/api/cron/alimtalk-reports`(5분)가 결과를 조회한다. 수신 완료 → `SENT`, **명시적 실패 코드만** 같은 본문 문자 1회 대체(`ACCEPTED→PENDING` 조건부 선점, `channel=SMS, fallback=true`), 2시간 무응답은 `UNKNOWN`(자동 재발송 금지). 대체용 본문은 `body_enc` 암호문으로만, 결과가 나면 지운다. mock 은 즉시 최종. `charge.mt_status` 는 `ACCEPTED` 일 때만 결과로 맞춘다.
  - SNS 게시 실패 처리(`fail`)는 `PUBLISHING` 일 때만 조건부로 바꾼다. 공급자 성공 뒤 기록 실패·30분 고착은 **자동 재게시하지 않고** `content_publish.status=UNKNOWN` — 기관이 "다시 게시"/"게시됨으로 표시"(`resolveUnknownPublish`)로 푼다. 예약(`schedulePublish`)은 `UNKNOWN` 을 덮지 않는다. 남은 예약이 없고 하나도 안 올라갔으면 콘텐츠는 `APPROVED` 로 돌아간다.
  - 캡션 길이는 `captionLinkReserve()`(실제 링크 최대 길이)로 맞춘다. SNS 어댑터에서 캡션 `slice` 금지 — 넘치면 `assertCaptionFits` → `CAPTION_TOO_LONG`. 유튜브 설명은 UTF-8 바이트 기준.
  - SNS 채널 만료는 인증 실패(`invalid_grant`·401·공급자 토큰 폐기)일 때만(`isAuthFailure`). 일시 오류는 `SocialTokenRefreshTransientError` — 연결 유지·이번 시도만 재시도. 게시 중 `AUTH_EXPIRED` 는 `markChannelExpired` + 재시도 없음.
  - 실연동에서는 mock 연결 채널을 게시·예약 대상에서 뺀다(`publishableChannelWhere`). 영상 없는 숏폼은 예약을 거절한다.
  - LLM 전송 전 가리기·개인정보 검사의 주민번호 패턴은 뒷자리 `[1-8]`(외국인등록번호 포함). 실명 패턴(`REAL_NAME_RE`/`realNameHit`)은 `llm-script.ts` 한 곳이고 콘텐츠 대본·AI 초안이 함께 쓴다. AI 초안 속도 제한은 저장소 장애 때 닫힌다(`failClosed`).
  - `/go` 클릭: 다음앱 인앱 브라우저(DaumApps)는 사람, 수집기는 `Daumoa` 만 제외. IP 를 모르면 UA HMAC 으로 나눠 중복을 센다.
  - 봉사 출석·불참은 회차 날짜뿐 아니라 시작 시각이 지나야 받는다. 회차 보관은 회차 행 `FOR UPDATE` 트랜잭션 안에서 진행 중 신청을 센다(신청의 자리 잡기와 직렬화).
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
- **승인 요청(`approval_request`).** "시스템이 준비하고 사람이 승인" 하는 일은 `requestApproval` + `registerApprovalHandler(kind)` 로 만든다. 결정은 PENDING→PROCESSING 조건부 선점, 처리기 실패 시 PENDING 으로 되돌림. 오래 걸리는 일은 `execute` 로 QUEUED → 배치 실행(아래 점검 조치 규칙).
- **저니(`src/server/services/journeys`).** 정의는 코드에 고정(광고성 단계 없음), 기관은 `/studio/journeys` 에서 켜기·단계별 '승인 후 보내기'·값만 바꾼다. 실행은 (저니, 이벤트) 유일. 발송 단계 공통 보호: 탈퇴·차단·`notice_opt_out_at` → 멈춤, 야간 21~9시 KST → 다음 날 9시(`JOURNEY_QUIET_HOURS=off` 로만 끔), 후원자당 7일 3건 상한 → 하루 보류(단계마다 14번 넘으면 건너뜀), 발송 전 예약(`journey:{runId}:{stepKey}`). 문서 단계는 `issuePurposeDocument` 만 부른다.
- **영수증 연간 준비.** `receiptCycle=YEARLY` 기관은 1~2월 `/api/cron/receipts` 가 발급 가능자를 승인 요청(RECEIPT_BATCH, 주 1회·대기·실행 중이면 새로 안 쌓음)으로 올리고, 미등록자에게는 `receipt.info_needed` → 저니가 등록 방법을 안내한다. 발급은 담당자 승인 후 events 배치가 나눠 실행. MONTHLY 기관에는 같은 배치가 `receipt.year_closed` 를 낸다.
- **통합 승인 대기함(`/studio/inbox`).** 승인 요청 + 콘텐츠 검토 + 봉사 신청 + 제출 문서 + 신고를 원천 테이블에서 모은다(복사하지 않음). 자동화 준비도(`automationReadiness`)는 같은 화면 위쪽에 — 빠진 항목이 무엇을 멈추는지 적는다.

### 2026-11-06 정밀 점검(자동화) 조치로 생긴 규칙

상세: `docs/2026-11-06_후원자동화_라이브바자회_정밀점검보고서.md` A-1~A-4, A-M1~A-M7. 테스트 `tests/automation-fixes-2026-11-06.test.ts`.

- **오래 걸리는 승인은 배치가 실행한다.** 처리기에 `execute`(시간 상한 `deadline`·이어 갈 `state`)를 두면 승인은 `QUEUED` 로만 기록하고 `/api/cron/events` 의 `runQueuedApprovals`(선점 = 잡는 순간 + `APPROVAL_RUN_LEASE_MS`)가 나눠 실행한다. 진행은 `payload.progress`, 결과 문구는 `approval_request.result`, 5회 실패면 `FAILED`(승인 대기함 "막힌 일"에서 다시 실행). 영수증 일괄 발급(RECEIPT_BATCH)이 이 방식이다 — 서버 액션 안에서 수백 건을 돌리지 않는다.
- `PROCESSING` 이 15분 넘게 남으면 `recoverStaleApprovals` 가 `PENDING` 으로 되돌린다. 그래서 **승인 처리기는 다시 불러도 같은 결과**여야 한다(이미 반영됐으면 성공). 처리기가 끝난 뒤 결과 기록이 실패해도 `PENDING` 으로 되돌리지 않는다. 대기함·관리자 배치 화면은 처리 중·실행 대기·실패를 보여 준다.
- **`charge.paid` 는 `charge-events.ts` 의 `emitChargePaid` 로만** 남긴다(정상 결제·관리자 수동 확정 모두, 승인 트랜잭션 안). payload 에 표시 이름을 넣지 않는다 — 이름이 필요하면 결제 건을 읽고 익명이면 "익명의 후원자"(`chargeDonorLabel`).
- **선점 시각은 잡는 순간**(`new Date()`/`elapsedClock`)이다. 배치 시작 시각을 선점 시각으로 쓰지 않는다. 배치마다 시간 상한(이벤트 60초·저니 90초·승인 실행 60초)을 두고, `events` 잠금 TTL(300초) ≥ 선점 유지(5분).
- **저니 발송 단계는 보내기 전에 예약한다.** 후원자 단위 advisory lock 아래에서 7일 상한을 다시 세고 `journey_step_log.dedupe_key = journey:{runId}:{stepKey}` 로 `SENDING` 행을 만든다. 같은 키가 있으면 다시 보내지 않는다(문서 단계는 발급 dedupeKey 로 결과만 맞춤). 보내지 않았으면 예약 행을 지운다. 7일 상한 기준은 (기관, 후원자) 그대로다(전체 기준 여부는 운영 결정).
- 단계가 넘어가면 보류 횟수(`context.deferrals`)를 0 으로. 결제에서 시작한 실행은 `context.chargeId` 로 **발송 직전 결제가 `PAID_STATUSES` 인지** 다시 보고, `charge.refunded` 소비자(`journey-refund`)가 진행 중 실행·승인 요청을 취소한다.
- 저니 `accept(ev, params)` 는 기관 설정값을 받는다. `recurring.milestone` 은 **출금 성공마다**(누적 횟수 포함) 나고, 정기후원 누적 감사는 기관이 적은 횟수에서만 실행을 만든다(고정 목록 없음).
- 봉사 전날 안내: 이벤트는 KST 9~21시에만 만들고, 발송 직전 신청 `APPROVED`·같은 회차·시작 30분 이상 전인지 다시 본다.
- **연말 감사장**: 연 1회 발급(YEARLY) 기관은 `receipt.issued`, 매월 발급(MONTHLY) 기관은 `receipt.year_closed`(1~2월 영수증 배치가 지난해 결제가 모두 영수증에 묶인 후원자에게 1회)로만 시작한다. 끝나지 않은 해의 영수증으로는 보내지 않는다. `receipt.issued` payload 에 `receiptNo`·`receiptCycle` 이 있다(영수증번호 머지).
- **약정 새 판**이 생기면 이전 판 서명 요청을 닫는다(internal 봉투는 시스템 취소 — 열기 전이면 환원, 그 외 EXPIRED). 조건 변경(금액·출금일·캠페인)은 약정당 하루 `AGREEMENT_CHANGES_PER_DAY`(3)회, 넘기면 바꾸기 전에 거절. internal 서명 화면 본문은 약정서 스냅샷 본문(`bodyOverride`). 잔액 부족으로 서명 요청이 막히면 기관에 하루 1회 알린다.
- **서명용 머지 PDF 는 비공개 저장소**(`EDocSnapshot.pdfObject`, `pdfUrl` 은 null)다. 서명 화면은 `/sign/[토큰]/pdf`(본인확인 쿠키), 기관은 `/studio/e-documents/[id]/pdf` 로만 읽는다(`snapshotPdfHref`). 머지 PDF 를 만들기 전에 잔액을 보고(`assertSendable`), 봉투·발급이 이루어지지 않으면 만든 파일을 지운다. 기관이 머지 필드 없이 보내는 서식 원본 PDF 는 예전처럼 공개 주소다.
- 봉투 거절·만료·취소는 같은 트랜잭션에 `document.closed` 를 남기고 `purpose-document-sign` 소비자가 반영한다. `/api/cron/edoc` 의 `reconcileClosedEnvelopes` 가 남은 불일치를 맞춘다.
- 후원자 탈퇴 → `closeDocumentsForWithdrawnPayer`(열람 토큰 삭제·진행 중 서명 봉투 시스템 취소). `/l/[토큰]` 은 기관이 `APPROVED` 가 아니거나 후원자가 탈퇴했으면 열지 않는다. 열람 문서 재발송은 토큰·발송 시각 조건부 선점(동시 클릭 1회).
- `RECURRING_CHANGE` 용도는 자동 발송 경로가 없다(`MANUAL_ONLY_PURPOSES` — 전자문서 센터에서 직접 보냄). 이벤트 종류마다 발생처·소비자를 `events.ts` 주석에 적는다. 발생처 없는 종류를 만들지 않는다.

## 용도별 자동 발송 문서 (2026-11-06)

- 서식(`DocumentTemplate`)에 `purpose`(`purpose-documents.ts` `DOCUMENT_PURPOSES`)·`autoSend`·`defaultSet` 이 있다. 기관×용도마다 **보관 전 서식 1개**(부분 유니크 인덱스 `document_template_merchant_purpose_one`). 중지(`active=false`)나 `autoSend=false` 면 그 용도는 보내지 않는다(`blocked: 'DISABLED'`).
- 기본 세트(`DOCUMENT_PRESETS` 의 `purpose`: 약정서·봉사 신청서·활동 확인서·변경 신청서·감사장 4종)는 `ensureDefaultPurposeTemplates`(`purpose-templates.ts`)가 기관 PRESET 서식으로 복사한다. 멱등·동시 호출 안전(P2002 = 이미 있음), 같은 presetKey 의 용도 없는 서식은 새로 만들지 않고 용도만 붙인다. 기관 승인 시점 + `issuePurposeDocument` 첫 호출 때 부른다. **운영 시드에는 넣지 않는다**(로컬 샘플 시드만). 기본 세트 서식은 서식 개수 상한에 넣지 않는다.
- 머지 필드 `{{후원자명}}` 등은 `src/lib/merge-fields.ts` 하나로 처리한다(`MergeContext` ↔ `mergeValuesFromContext`). 값이 없으면 빈칸 + `missing`, 모르는 이름은 그대로 두고 미리보기에서 경고, 값 안의 전화·주민번호 꼴은 마스킹, HTML 로 그릴 때는 본문·값 모두 이스케이프(`renderMergeHtml`). 파일 서식은 편집 기록의 새 글자에 치환해 **새 PDF** 를 만든다(`renderMergedTemplatePdf` — 원본·서식 결과 PDF 불변, 열람 문서는 비공개 저장소). 기관이 직접 보내는 서명 요청에도 기관명·대표자·발급일·서명자 이름은 채운다.
- 저니·소비자는 `issuePurposeDocument` 만 부른다(계약은 `purpose-documents.ts`, 구현은 `issued-documents.ts`). 서명 불필요 용도는 `issued_document` + 열람 토큰(해시만, 30일) → `/l/[토큰]`(noindex·인쇄, 만료 후 `/my/documents`), 안내는 `tplDocumentIssued`. 서명 필요 용도(`SUPPORT_AGREEMENT·VOLUNTEER_APPLICATION·RECURRING_CHANGE`)는 `createEnvelope`(서명자 1명=후원자, actor `system`, 이용요금 차감 그대로, 봉투 id 는 dedupeKey 에서 결정)로 보내고 잔액이 없으면 `blocked: 'EDOC_BALANCE'`. 탈퇴 후원자는 `WITHDRAWN`. 같은 `dedupeKey` 는 한 번(`already: true`, link null).
- 약정서·신청서(`agreements.ts`)는 기관 용도 서식 본문을 머지한 결과를 스냅샷 `form` 에 고정한다(기존 스냅샷 필드·해시·판 규칙 그대로). `ESIGN_PROVIDER=internal` 이면 전자문서 센터 봉투로 서명을 받고(`agreement_document.esign_request_id = edoc_envelope.id`, 발송 키 `agreement:{약정서 id}`), 봉투가 끝나면 `syncIssuedFromEnvelope` → `completeESign` 으로 반영한다(edoc 완료 지점에서 직접 + `document.signed` 소비자 `purpose-document-sign` 로 재확인). internal 은 mock 이 아니라 운영 부팅 점검을 통과한다.
- 콘솔: `/studio/documents?tab=purposes`(용도별 현황), `/studio/documents/issued`(발급 목록·재발송·보관). 후원자: `/my/documents`. 기부금영수증은 이 기능으로 만들지 않는다(연말 감사장은 별도 용도, "영수증이 아님" 을 적는다).

## 라이브 바자회 (2026-11-05)

상세: `docs/2026-11-05_라이브바자회_개발완료보고서.md`. 기획: 프로젝트 문서 `기브싸인_라이브바자회_개발계획_v4_최종안_2026-11-05.md`.

- **흐름:** 기업·개인 현물 기부 → 기관 매칭(기관 수락) → 가액 협의·확정 → 기부자 약정 → 입고·검수(관리자) → 기관 검수 확정 = 현물 기부금영수증 발급 + 판매 상품 생성 → 셀러브릭스 바자회 센터 창고 등록·방송(기브싸인 소속 셀러) → 판매 결과 입력·승인 → 월 1회 기관 정산·지급.
- **판매 구조:** 기관 → 회사 위탁판매. 셀러브릭스 코드는 바꾸지 않는다(1단계). 판매 결과는 관리자 수기·CSV 입력이고, 2단계에서 같은 표(`bazaar_sale_batch/line`)에 API 공급원(`source=API`)을 붙인다.
- **스위치:** `system_setting 'live_bazaar.enabled'`(기본 꺼짐), 최고관리자 `/admin/site-settings`. 판단은 `isLiveBazaarEnabled()` 하나(1초 캐시). 꺼지면 메인 섹션·공개 `/bazaar`·`/giver`·`/studio/bazaar`·`/admin/bazaar`·메뉴·푸터·사이트맵·가입 안내·서버 액션·파일/CSV API 가 모두 사라진다(404, 404 화면에 바자회 문구 없음). **예외(대표 결정):** ① 정산 `/admin/in-kind-settlements` 는 꺼져도 열린다(문구 "현물 판매 정산"). 꺼져도 이미 승인된 판매분의 집계·확정·이월·지급은 그대로 한다(새 판매 결과는 받지 않음) ② 발급된 현물 기부금영수증은 기관 `/studio/receipts` 와 홈택스 명세에 계속 포함되고, 정정(무효·재발급)은 `/admin/in-kind-receipts`(꺼져도 열림, 최고관리자)에서 한다. 새 화면을 만들 때 반드시 `bazaarPageGuard()`/`assertBazaarEnabled()` 를 건다(위 예외 화면에는 바자회 문구를 쓰지 않는다).
- **계정:** 현물 기부 회원은 `UserRole.GIVER` + `in_kind_donor`(donorType CORPORATE/INDIVIDUAL). 기관 후원 회원(`DonorMember`)·통합 후원자와 섞지 않는다. 셀러는 기브싸인 로그인이 없다(`bazaar_seller` 명단).
- **상태 전이**는 `bazaar.ts transition()` 만 쓴다(조건부 갱신 + `in_kind_status_log` append-only). 상태값은 `src/lib/bazaar.ts` 문자열 상수.
- **현물 영수증** `in_kind_receipt`: 번호 `{기관코드}-{연도}-H{6자리}`, 기관 검수 확정 때만 발급, 금액 = 확정 단가 × 합격 수량. 개인은 주민번호 3분리(발급·명세에서만 복호화), 기업은 사업자번호. 정정은 무효(VOID) 후 재발급, 번호 재사용 없음.
- **원장** `bazaar_ledger` append-only(트리거), 멱등키 `sale:/refund:/fee:/return:/inbound-return:/payout:`. 수수료는 설정값(기본 30%, 부가세 포함/별도는 설정)이고 공급가액·부가세를 나눠 기록한다. 이번 달 정산이 확정·지급됐으면 새 원장은 다음 달로 넘어간다. 판매 결과 승인은 입력자 ≠ 승인자(최고관리자는 사유를 적으면 단독 승인).
- **추적 코드** `GSB-000001`: 셀러브릭스 상품명 앞에 붙인다. 추적 코드 없는 판매(셀러브릭스 임시상품)는 판매 결과 입력에서 거절된다.
- 접수 금지 품목·유통기한 30일 미만은 `blockedKeyword()`·`validateDonationInput()` 에서 막는다. 주류는 종류 이름(소주·맥주·와인·위스키·막걸리 등)까지 막고, 잔·오프너 같은 용품만 예외(`BLOCKED_KEYWORD_EXCEPTIONS`).
- 테스트: `tests/live-bazaar.test.ts`, 점검 조치 회귀 `tests/live-bazaar-fixes.test.ts`, 화면 흐름 `node e2e/live-bazaar-e2e.mjs`(서버 + 시드 DB 필요).

### 2026-11-08 점검 조치로 생긴 규칙 (`docs/2026-11-06_후원자동화_라이브바자회_정밀점검보고서.md` B 항목)

- **정산 동시성.** 원장 월을 정하거나 정산을 집계·확정·이월·지급하는 코드는 모두 `lockMerchantSettlement(tx, [merchantId])`(기관별 `pg_advisory_xact_lock(778202, hashtext(id))`) 아래에서 한다. 판매 결과 승인은 기관 잠금 → 상품 `FOR UPDATE`(id 정렬) 순서. 확정은 잠금·재계산·DRAFT 조건부 갱신을 **한 트랜잭션**으로, 집계 갱신도 `status: 'DRAFT'` 조건부다. 잠금 없이 `openMonthFor` 를 부르지 않는다.
- **0원 이하 정산 = 이월.** 확정 때 지급액 ≤ 0 이면 `CARRIED` 로 닫고, 그 달에 `CARRY_OUT`(+|금액|, `carry-out:{정산 id}`), 다음 열린 달에 `CARRY_IN`(금액, `carry:{정산 id}`)을 남긴다. 정산 합계는 `PAYOUT`·`CARRY_OUT` 을 빼고 `CARRY_IN` 을 `carryAmount` 로 더한다. 0원 이하 정산은 지급 기록을 하지 않는다. 미지급 요약·"정산 예정"은 지급액 > 0 만 센다. 예전 데이터(0원 이하 CONFIRMED)는 "다음 달로 이월" 버튼(`carryOverSettlement`).
- **판매 결과 승인 재검증.** 입력 때는 승인+대기 묶음 합으로, 승인 때는 **승인된 묶음만**으로 재고·환불 한도를 다시 본다(반려된 판매를 근거로 한 환불 거절). 판매 수량은 이미 판매 결과에 든 수량 아래로 줄일 수 없다.
- **요율 기록.** 승인 때 판매 줄에 `fee_rate_percent/fee_vat_mode`(판매분), 환불이 있으면 `refund_fee_rate_percent/refund_fee_vat_mode`(그 상품의 가장 최근 승인 판매 요율)를 남기고 `settleLine(line, 판매요율, 환불요율)` 로 계산한다. 화면 미리보기는 `lineRates()`.
- **가액 확정은 제안 id 로.** `acceptValuation(donationId, actor, valuationId)` — 화면이 본 제안(`valuationId` hidden)이 최신 제안이 아니면 거절. 제안·확정·검수 확정·영수증 무효·재발급은 기부 건 `FOR UPDATE`(`lockDonation`). 최신 제안은 `createdAt desc, id desc`.
- **참여 승인 가드.** 기관 콘솔 변경 액션은 `requireBazaarMerchant()`(참여 `APPROVED` 필수). 참여 신청·상태 조회만 `requireBazaarMerchantAny()`. 서비스도 `assertMerchantParticipating`/`assertEligible`(수락 시 공익법인 지정 재확인)로 다시 막는다. 정지·반려하면 대기 중 매칭 제안을 `WITHDRAWN` + 상태 이력으로 되돌린다.
- **현물 영수증 1장.** 기부 건당 `ISSUED` 는 1장(부분 유니크 `in_kind_receipt_donation_issued_one`). 영수증 금액 = 확정 단가 × (합격 수량 − `bazaar_product.returned_qty`). 남은 물품을 기부자에게 반환(`RETURN`)하면 반환 수량을 기록하고 상태 이력에 "영수증 정정 필요"를 남긴다. 정정(무효 → 재발급) 전에는 종결하지 않는다(`receiptCorrectionNeeded`).
- **판매 결과 CSV.** 8개 열 정확히(따옴표 없는 "10,000" 처럼 밀린 줄 거절), 따옴표 안 줄바꿈 지원(`splitCsvRecords`), UTF-8 이 깨지면 CP949(`TextDecoder('euc-kr')`)로 읽는다(`decodeCsvBytes`). 판매 금액이 수량 × 판매가의 절반 미만 또는 수량 × (판매가+배송비)의 2배 초과면 거절(`amountMismatch`). 추적 코드는 숫자를 끝까지 읽는다(`GSB-0000012` 는 코드가 아님, 1,000,000번부터 7자리). 다음 번호는 문자열이 아닌 숫자 최대값.
- **업로드.** 서버 액션 본문 상한 `experimental.serverActions.bodySizeLimit = '32mb'`(next.config.ts) = 파일 6개(`BAZAAR_UPLOAD_MAX_FILES`) × 5MB + CSV 2MB + 여유. 바꾸면 상수·안내 문구를 함께. 파일은 `prepareDonationFiles`(개수·크기·매직바이트, 사진은 이미지만)로 **DB 에 손대기 전에** 검사하고, 저장소에 먼저 올린 뒤 기부 건과 같은 트랜잭션에서 `in_kind_file` 을 만든다(실패 시 올린 파일 삭제). 근거 자료는 `DONOR_EVIDENCE_STATUSES` 단계에서만, 기부 건당 20개.
- **권한.** 입고·검수, 판매 결과 입력·반려, 판매 종료는 `MONEY_PERMISSIONS`(최고관리자·운영·재무)만 — 고객지원·읽기 전용 불가. 기부자 대장·셀러브릭스 등록 정보·관리자용 현물 기부 대장 CSV 도 같은 화이트리스트이고, 대장·셀러브릭스 반출은 감사로그(`BAZAAR_LEDGER_EXPORT`·`BAZAAR_SELLERBRICKS_EXPORT`·`BAZAAR_GIVERS_EXPORT`). 현물 기부 회원(GIVER)은 기관 도입 신청을 할 수 없다(별도 계정 안내).
- **배치.** 매칭 수락 기한 만료는 `/api/cron/bazaar`(1시간, `cron-registry.ts` `bazaar`, 스위치 꺼지면 건너뜀). 기한 지난 제안은 기관 상세·파일을 열 수 없다.
- **설정 검증.** `validateConfigInput` 이 범위(`BAZAAR_CONFIG_RANGES`)·요율 형식(`isFeeRateString`, `1e1` 거절)을 검사해 오류 문구로 돌려준다. 범위 밖 값을 기본값으로 바꿔 저장하지 않는다.
- **그 밖.** 편성은 참여 승인 기관만(상품 없는 편성 포함), 방송 주소 변경·편성 승인/반려·종결은 감사로그. 가액 이력은 `valuationKindLabel`(영문 코드 노출 금지). 되돌릴 수 없는 버튼(수락·거절·가액 확정·약정·재발급·종결·반려·판매 종료·방송 완료·이월)은 `confirm` 필수. 입고일 귀속 연도가 지난해면 검수 확정 화면에 홈택스 명세 재생성 경고.
- **결정 필요(코드는 안전한 쪽으로만).** ① 수수료 반올림은 판매 줄 단위(월 합계 반올림과 원 단위 차이) ② 원장 귀속 월 = 승인일 기준 열린 달(판매일 아님, 묶음 `month` 는 기관별 원장 월 목록) ③ 법인·사업자 현물 영수증은 홈택스 명세 파일 끝 별도 구역(`HOMETAX_CORPORATE_COLUMNS`)에만 두고 개인 주민번호 열에 넣지 않는다 — 제출 방식은 세무 확인 후.

## 2026-11-09 정기후원 실패 복구 · (선택) 소식 수신 동의

테스트 `tests/recurring-recovery-2026-11-09.test.ts` · `tests/marketing-consent-2026-11-09.test.ts`.

- **실패 원인 분류는 `recurring-failure.ts` 한 곳**(결제 건 상태 + 최근 결제 거래 `result_code`). 결제사 코드표는 `RECURRING_CODES_INSUFFICIENT/_ACCOUNT/_AUTH/_TEMPORARY` 환경변수만, mock 기본표는 `provider='mock'` 거래에만. 모르는 코드·빈 코드표 = `UNKNOWN_REASON` = 예전 동작(3일·3회·같은 문자). 결과 미확인(PENDING)은 분류하지 않는다. 정책은 `RECURRING_FAILURE_POLICY` 표로만 바꾼다(업무 코드에 분기 추가 금지).
- 일시 오류는 다음 날·문자 없음·주기 안 연속 2회까지 정지 횟수 제외. 잔액 부족은 `paydayRetryDate`(11·26·1일, 다음 주기 넘으면 3일). 계좌·인증·결제수단 없음은 자동 재시도 없이 `recovery_state=ACTION_REQUIRED` + `action_deadline_on`(오늘+14와 다음 주기 전날 중 이른 날) — 기한까지 새 결제수단(실패 뒤 `registered_at`)이 없으면 정지(`recurring.suspended`, 주기당 1회 키). 한도는 다음 날.
- 결제수단 등록은 `payment_method.registered`(merchantId 는 등록 링크 기관, 없으면 빈 값) → `recurring-recovery` 소비자가 조치 필요 약정의 `next_charge_on` 을 오늘로 당긴다. 등록 함수에 정기후원 코드를 넣지 않는다. 같은 주기 실패 뒤 성공 = `recurring_run.recovered` + `recurring.recovered:{id}:{cycle}`, 복구 상태는 성공·재개·해지·정지 때 비운다.
- 후원자 복구 링크 `/r/recover/[토큰]`(`recurring_recovery_link`, 해시만, 15일, 여러 번 열림, 새 링크가 이전 링크 무효). 링크는 그 약정 1건만. 버튼은 기존 업무 함수만 부른다(등록 = REGISTER_ACCOUNT 보안 링크). 복구 링크가 든 실패 문자는 vars 없음(관리자 본문 미적용) — 잔액 부족도 코드는 `RECURRING_FAILED`.
- 날짜를 정한 일시정지(`resume_on`)는 정기후원 배치가 그날 재개하고 전날 안내 1회(`resume_notice_sent_at` 선점). 날짜 없는 일시정지·재개·해지는 `resume_on` 을 비운다. 결제수단이 없으면 자동 재개하지 않는다.
- 승인 대기함 묶음은 `recurringRecoveryInboxGroup(merchantId)`(없으면 null) — 연결은 총괄.
- **(선택) 기관 소식·후원 안내 수신 동의**는 (후원자, 기관) 단위 `payer_merchant_link.marketing_consent_*` + 이력 `marketing_consent_log`(문구·판). `consent_record`(약관 버전 필수·기관 구분 없음)·`notice_opt_out_at`(월간 안내)·기브싸인 MARKETING 동의와 다른 것이다. **아직 이 동의로 아무것도 보내지 않는다.** 체크칸은 `MarketingConsentField`(기본 해제·필수 동의와 분리), 체크하지 않으면 아무것도 바꾸지 않는다. 웹·MO 후원은 결제 건 의사(`marketing_consent_intent`) → `charge.paid` 소비자 `marketing-consent` 가 반영(본인 확인 전 동의 금지). 후원 회원 가입 체크는 휴대폰 인증으로 후원자와 이어질 때 옮기고, 철회한 적이 있으면 되살리지 않는다.

## 2026-11-09 승인 대기함(예외 해결)·문서 발송 전 점검

- **문서 발송 전 점검**(`src/lib/document-preflight.ts` 판정 + `src/server/services/document-preflight.ts`). `issuePurposeDocumentImpl` 이 잔액 확인·PDF 렌더 **전에** 점검한다. block → 보내지 않고 `blocked: 'PREFLIGHT'`(사유 앞머리 `PREFLIGHT_BLOCK_PREFIX`), warn → 보내고 `issued_document.preflight_warnings` 에 남긴다. 필수 필드(`PURPOSE_REQUIRED_FIELDS`)는 **서식이 실제로 쓰는 필드만** 본다. 약정서 출금일은 경고(`PURPOSE_RECOMMENDED_FIELDS`). 이름 없는 후원자는 기본 이름(`후원자{끝4자리}`)으로 채운다. 파일 서식 글자 폭은 `pdf-form/measure.ts`(원본 글꼴 /Widths → 대체 글꼴).
- 저니 문서 단계가 PREFLIGHT 로 막히면 `JourneyBlockedError` → 재시도 없이 실행 `FAILED`(막힌 일), 발송 예약은 지운다. 기관이 고친 뒤 `retryJourneyRun`(FAILED 조건부)로 다시 실행한다.
- **표본 미리보기**(`previewSamples` — 정상·빈칸·이름이 가장 긴 것 3건)와 서식 "점검"(`/studio/documents/[id]/preflight`, `?mode=stress` 가상의 긴 값)은 **저장·발송하지 않는다**(파일 서식 첫 쪽 PDF 는 메모리에서만).
- **승인 대기함 원인별 묶음**(`inbox-groups.ts`): 형식 `InboxExceptionGroup`(다른 영역과 맞춘 것 — 바꾸지 않음), 다른 영역은 `registerInboxGroupProvider(name, fn, label)`. 제공자 실패·8초 초과는 그 묶음만 "불러오지 못함". 정렬 = 기한 넘김 → high → 영향 큰 순 → 오래된 순. 결과 미확인(UNKNOWN)은 "다시 실행" 없이 "결과 확인"만.
- 묶음 바로 실행(`inbox-actions.ts`)은 기존 경로만: 영수증 정보 안내 = `receipt.info_needed`(연간 배치와 같은 dedupeKey, 수신 거부·차단·탈퇴·번호 없음 제외) → 저니, 막힌 안내 = `retryJourneyRun`, 서명 재안내 = `remindSigner` + 서명자·KST 날짜 하루 1회 선점(`kv.setnx`).
- **담당·기한**(`inbox_assignment`, (기관, 항목 키) 유니크). 기한 넘김 알림은 `/api/cron/inbox`(1시간, `cron-registry.ts`)가 기관 소유자 계정에 콘솔 알림 1회(`overdue_notified_at` 조건부 선점, 기한을 바꾸면 다시). 처리돼 사라진 항목의 배정은 닫는다. 지금 기관당 담당자 계정은 1개라 화면은 기한·메모만.
- 사이드바 배지(`inboxActionCount`)는 그대로 **항목 수**다(묶음 수가 아님). RECEIPT_BATCH 는 `/studio/inbox/approvals/[id]` 확인 화면(대상 수·표본·제외 이유·비용 0원)을 거쳐 승인한다 — 정보만, 발급 판정은 영수증 대장 규칙 그대로.

## 2026-11-09 문자 후원 단계 측정 · 콘텐츠 승인

- **단계 측정**(`funnel.ts`, 표 `funnel_step`)은 (흐름, 단계) 유니크로 **처음 도달만** 남긴다. 흐름 키는 MO `mo:{수신 id}`(그 문자의 결제 건 포함)·웹 `charge:{결제 id}`. 단계: `MO_RECEIVED → REPLY_SENT → LINK_OPENED → AMOUNT_SELECTED → AUTH_STARTED → PAID`, 끝 `FAILED/BLOCKED`(이유 `LIMIT·UNREGISTERED·PAYMENT_FAILED·CONTENT_BLOCKED·EXPIRED`). 개인정보 원문 없음, 정기·테스트 결제 제외.
- 결제 함수에는 `recordFunnelStep`/`recordChargeStatusStep` **한 줄 호출만** 넣는다(예외를 던지지 않는 안전 래퍼). 상태 전이는 `charge-flow` `setStatus` 한 곳에서 잡고(PENDING_PIN → 인증 시작, 실패·차단 → 끝 상태), PAID 는 승인 트랜잭션 **커밋 뒤**(정상·관리자 확정). 링크 열람은 `/r/[token]` 금액 선택 화면에서 `isBotUserAgent`(= `/go` 판정)로 미리보기 봇을 뺀다. 웹은 금액 제출부터(방문 수 없음).
- 집계(`funnel-report.ts`)는 **측정 시작 이후만** — 기간 안에 시작 단계(MO `MO_RECEIVED`, 웹·QR `AMOUNT_SELECTED`)를 기록한 흐름만, 단계 수는 흐름별 최고 단계 기준. 예전 결제 건을 상태로 거꾸로 채우지 않는다. 화면: `/studio/reports?tab=funnel`, 관리자 `/admin` 카드. 미완료 1회 안내(M7)는 만들지 않았다(정책 결정 대기).
- **콘텐츠는 항상 사람이 승인해야 게시된다**(대표 결정). `autoApprove` 컬럼은 호환용으로만 남고 저장은 항상 false, 읽지 않는다. `approvedBy='AUTO'`·시스템 이름 승인 금지(테스트가 소스를 검사한다). 승인은 `REVIEW` 조건부 갱신(동시 클릭 1회). 슬롯 시각이 지난 미승인은 게시하지 않고 "게시 시각 지남", 늦은 승인은 `whenPast` = 다음 빈 슬롯(`moveSlotToNextFree`, 화면 기본)·지금·승인만(서비스 기본 — 인자 없으면 예전대로 예약 안 함).
- 주간 승인 `/studio/content/review`(이번 주·다음 주, KST 월~일, 지난 대기는 이번 주에), 일괄 승인은 항목마다 `approveContent`(승인 불가는 이유와 함께 건너뜀, 50건 상한). 반려(이유 분류+메모) → `ARCHIVED`, 수정 요청 한 줄 → 새 판(`revision_of/root_id/request`, 이전 판 보관, 슬롯 이어받음, 판 묶음당 하루 5회, advisory lock). 메모·요청은 실명·연락처 거절 후 `maskForLlm` 값만 저장. mock 이면 요청은 메모로만("AI 공급자 연결 후 문장 반영").
- 반려·수정 이유는 `content_feedback` 에 쌓고 최근 20개를 `contentAvoidHints` 로 LLM 프롬프트 "피해야 할 것" 에 넣는다(로그 금지). 사전 점검(`contentPrecheck`)은 기존 검사(`contentDraftViolation`·`captionProblem`·실명/연락처 패턴)만 부른다.
- 알림 배치 `/api/cron/content-review`(15분): 월요일 09시 이후 그 주 대기 N건(기관·주 1회), 슬롯 하루 전·3시간 전 미승인(콘텐츠·슬롯 시각·시점 1회) — `content_review_alert` 키와 알림을 한 트랜잭션. 기관 담당자 문자·알림톡 정보성 경로가 없어 콘솔 알림만.

## 2026-11-09 입금 자동 대사 (기관 통장 거래내역)

테스트 `tests/deposits-2026-11-09.test.ts`, 샘플 `tests/fixtures/bank-*-2026-11-09.*`. 화면 `/studio/deposits`(사이드바 "입금 맞추기").

- 기관 통장으로 바로 들어온 계좌이체·CMS 는 **기브싸인이 받은 돈이 아니다.** 확정분은 `offline_donation` 에만 남기고 `charge`·정산 원장·수수료·캠페인 모금액(절대 규칙 10)·후원 내역 숫자에 넣지 않는다. 화면은 "기브싸인 결제" 와 "계좌이체" 를 나눠 보이고 합쳐 한 숫자로 바꾸지 않는다(`SupporterRow.offlineAmount`, 대시보드 `OfflineMonthStrip`).
- 파일 읽기는 `src/lib/bank-statement.ts`(열 자동 인식·값 읽기·이름 키) + `bank-statement-file.ts`(CSV UTF-8/CP949 = `decodeCsvBytes`, XLSX 는 node:zlib 로 첫 시트만, `.xls` 거절). 모르는 열은 저장 없이 `NEEDS_MAPPING` → 열 고르기. 2MB·입금 5,000건. 출금 행 버림. **계좌번호 원문 저장 금지** — 계좌 열을 읽지 않고 이름·적요의 긴 숫자는 `maskLongDigits`. 파일 자체도 저장하지 않는다.
- 중복: 같은 파일 = `bank_statement_import (merchant, file_hash)` 유니크, 같은 입금 = `bank_deposit (merchant, tx_hash)` — (기관, 거래일시, 금액, 입금자 키, 잔액, 파일 안 같은 값 순번) SHA-256. 같은 날 같은 사람·금액은 둘 다 남기고 `duplicate_warning`(자동 확정 안 함).
- 맞추기 규칙은 `classifyDeposit` 한 곳. 후보 = 그 기관과 관계있는 후원자(결제·정기 약정·봉사·명단·계좌이체·약정, 병합은 대상으로, 탈퇴 제외) + 후원자 계정 없는 명단 행. 자동 확정은 **이름 일치 1명 + 같은 금액 확정 입금 2회↑ 또는 같은 금액 계좌이체 약정**만. 확인 필요/모름은 사람이 확정한다. 확정할 후보는 입금 행에 저장된 후보 중에서만(`confirmDeposits`), 새 후원자 연결은 이름·휴대폰(같은 번호 후원자 재사용, 표시 이름은 비워 두고 기관 명단에만 이름).
- 확정 = 입금 `UNMATCHED/SUGGESTED → MATCHED` 조건부 + `offline_donation` + `offline.received`(dedupe `offline.received:{입금 id}`) 한 트랜잭션. 입금당 CONFIRMED 1건(부분 유니크). 되돌리기 = `REVERTED`(행 보존) + 입금 다시 확인 필요 + `offline.reverted`. 다시 확정해도 감사 이벤트는 다시 나지 않는다.
- 소비자: `offline-alert`(같은 묶음 id 여러 건이면 알림 1건, kv 선점), 후원 감사 저니는 `includeOffline` 값을 켰을 때만(기본 끔), 발송 직전 `context.offlineDonationId` 가 CONFIRMED 인지 재확인, `journey-offline-revert` 가 진행 중 실행 취소.
- **계좌이체 약정**(`offline_pledge`, 기관·후원자당 1건)은 매칭 근거와 "이번 달 미입금"(약정일+3일) 표시에만 쓴다. 출금·결제·문자를 만들지 않는다.
- **영수증**: `merchant_profile.receipt_include_offline`(기본 끔)일 때만 `receiptCandidates`·`issueReceipt`·연간 준비·홈택스 명세·후원자 미발급 요약에 확정 계좌이체를 넣는다. 끔이면 결과가 예전과 완전히 같다(테스트로 비교). 영수증 items 의 계좌이체 줄은 `offlineDonationId`·`source:'OFFLINE'`, `chargeCount` 는 결제+계좌이체 건수. 발급된 영수증에 묶인 계좌이체를 되돌리면 **자동 VOID 하지 않고** "정정 필요"(`offlineReceiptCorrections`) — 무효 처리(`voidReceipt` 가 묶음을 풀어 줌) 후 재발급은 확정분만.
- 승인 대기함 묶음 `offline-deposits`("입금 확인 필요 N건", `depositsInboxGroup`). 권한은 기관 콘솔 계정(`requireMerchant`, 기관당 계정 1개 — 별도 금전 권한 없음), 업로드·확정·무시·되돌리기·약정·설정 변경은 감사로그(`OFFLINE_*`, `RECEIPT_INCLUDE_OFFLINE_CHANGE`). 은행 계좌 직접 조회 연동은 하지 않았다(5차, 어댑터+mock 예정).

## 2026-11-09 후원자별 다음 업무 · 통합 발송 관리

테스트 `tests/outbound-next-action-2026-11-09.test.ts`.

- **다음 업무**(`next-action.ts`): (기관, 후원자) → 한 가지 + 이유, 규칙만(예측 없음). 우선순위는 `nextActionOrder` 한 곳 — 환불 진행 중·열린 문의(담당자 확인) > 정기 출금 조치 > 서명 미완료 > 영수증 정보 미등록(1~2월은 서명보다 앞) > 첫 후원 감사(첫 후원 60일 안) > 봉사 신청 확인 > 없음. 저니가 그 일을 처리 중이면 `autoHandled` + 다음 실행. 목록·대시보드는 `nextActionsForMerchant`(기관 단위 일괄 — 후원자마다 쿼리 금지), 담당자 할 일 = `needsStaff`. 화면: `/studio/donors/[payerId]` 카드, 후원자 관리·후원자·봉사자 열·필터, 대시보드 한 줄.
- **자동 안내 멈춤**(`outbound/pause.ts`): 열린 문의(OPEN)·진행 중 환불(REQUESTED·APPROVED)이면 관계·정보형 저니 단계와 대기열 안내를 하루씩 보류(기존 보류 기구). 거래·요청형은 멈추지 않는다.
- **발송 분류표는 `outbound/classify.ts` 한 곳.** 표에 없는 템플릿 = 거래·요청형 = 지금처럼 바로 발송. 새 안내를 만들면 분류부터 적는다. 7일 상한 상수 `RELATIONAL_WEEKLY_CAP`(= `JOURNEY_WEEKLY_SEND_CAP`), 기준 (기관, 후원자) 유지.
- **발송 대기열**(`outbound/coordinator.ts`, 표 `outbound_queue`, 배치 `/api/cron/outbound` 1분): 관계·정보형(저니 문자 단계·자동 문서 첫 안내·월간 안내)은 `sendRelational` 로만 보낸다 — 발송 키 유니크, `OUTBOUND_COALESCE_MINUTES`(기본 10분) 뒤 같은 (기관, 후원자) 대기분을 한 통(LMS 2,000바이트 넘으면 나눔)으로, 1건이면 원래 템플릿 그대로. 선점 = 후원자 advisory lock + QUEUED→SENDING(lockedBy), 15분 넘은 SENDING 은 다시 보내지 않고 UNKNOWN. 결과는 원천(저니 단계 기록·발급 문서·월간 안내 기록과 실행 집계)에 되돌려 적는다. 상한은 저니 기록 + 대기열 발송을 함께 센다(`relationalCapCount`); 저니가 예약하며 센 안내(`precounted`)는 다시 세지 않는다. 넘치면 낮은 우선순위(월간 < 누적·봉사 감사 < 감사장·연말 < 영수증 안내)부터 하루 보류, 3번이면 건너뜀. 야간 21~9시 공통. 묶음은 알림톡 템플릿이 없어 문자로 나간다.
- **`OUTBOUND_COORDINATOR=off`** 면 대기열 없이 지금 경로 그대로(이미 쌓인 것만 배치가 보낸다). 테스트 기본은 묶음 대기 0(`tests/setup.ts`), 묶음 테스트만 늘린다.
- **선호 채널** `payer_profile.preferred_channel`(ALIMTALK 기본·SMS) — `sendMtDetailed` 의 알림톡 경로 결정에서만 반영(화면은 2차 F).
- **알림톡 결과 미확인(UNKNOWN)** 은 그대로 자동 재발송 없음. 닫을 때 본문 암호문을 `resend_body_enc`(14일)로 옮기고, `/studio/journeys` 목록의 "문자로 다시 보내기"가 `manual_resent_at` 조건부 선점으로 1회 보낸다(새 이력 행, `manual_resend_id`). 같은 화면에 최근 30일 안내 5단계(요청→접수→전달→열람→완료, `outbound/stage-stats.ts` — 열람·완료는 기존 기록만 잇고 없으면 "-")와 대기열 현황.

## 2026-11-09 후원자 셀프서비스

테스트 `tests/self-service-2026-11-09.test.ts`.

- **정기후원 관리 한 화면**은 통합 `/my/recurring` 과 기관 후원 회원 `/donate/[code]/my/recurring` 이 같은 서비스(`donor-self-service.ts`)를 쓴다. 범위: MY = 계정에 연결된 후원자의 모든 기관, MEMBER = 회원이 휴대폰 인증한 번호의 후원자 중 **그 기관 약정만**(다른 기관 id 는 "찾을 수 없음"). 바꾸는 일은 기존 함수(`updateRecurringDonation`·`pauseRecurringUntil`·`setRecurringStatus`)만 부른다 — 금액 범위·하루 3회·약정서 새 판 그대로. 복구 링크(`/r/recover`)는 1차 규칙 그대로(그 약정 1건, 재확인 없음).
- **변경 결과 문장은 `describeRecurringChange(before, after, now)`(`recurring-change-text.ts`, 순수 함수) 한 곳.** 저장 전 미리보기와 저장 후 확인이 같은 문장이다. 날짜 규칙을 바꾸면 recurring.ts 갱신 규칙과 이 함수를 함께 바꾼다. 결과 미확인(PENDING) 실행이 있으면 금액·출금일 변경은 보류(셀프서비스 경로만 — 기존 함수는 그대로), 정지·해지는 안내 문장과 함께 허용.
- **변경·정지·재개·해지는 로그인 + 휴대폰 재확인 1회(10분)** — `self-service-stepup.ts`(대상 USER/MEMBER, 이미 연결된 번호로만 발송, 번호 해시와 묶음, 번호가 바뀌면 무효). 옛 액션 `updateRecurringAction`(금액·출금일이 바뀔 때)·`setRecurringStatusAction` 도 같은 재확인을 요구한다. 같은 약정 동시 변경은 `kv.setnx` 잠금으로 1건만.
- **변경 이력 `recurring_change_log`**(actor `DONOR`·via `MY/MEMBER/RECOVER_LINK`·kind·전후 스냅샷·문장·사유). 기록 실패는 변경을 되돌리지 않는다(`recordRecurringChange` 안전 래퍼). 후원자 화면 카드와 기관 `/studio/recurring` "최근 변경 이력"(누가: "후원자 본인")에 보인다.
- **알림 설정 한 곳**: `/my/notifications`·`/donate/[code]/my/settings` — 연락 선호 `payer_profile.preferred_channel`(`ALIMTALK_FIRST|SMS_ONLY`, 기본 알림톡 우선, 2차 D 와 같은 정의 — 마이그레이션은 `ADD COLUMN IF NOT EXISTS`) · 월간 안내 수신 거부(`notice_opt_out_at`) · (선택) 소식 수신 동의(1차 함수). 발송 경로가 선호값을 읽는 것은 D 의 몫이다. 결제 링크·인증번호는 항상 문자.
- 후원 내역(`donor-history.ts`)은 연도별 합계 + 건별(출처 표시). 원천은 결제 건이고 다른 출처(2차 E 계좌이체 확정분)는 `registerDonationHistorySource(name, fn, label)` 로 붙인다(실패한 출처만 빠짐). 영수증 발급 시기 안내는 `receiptScheduleNote(receiptCycle)` 하나.
- 받은 문서(`donor-documents.ts`)는 감사장·확인서 + 약정서(SIGNED·NONE 판만). 회원 화면은 그 기관 문서만, `/donate/[code]/my/documents/[id](/file)`·`/agreements/[id]`. 만료된 `/l/[토큰]` 은 그 기관 회원 로그인·통합 로그인으로 받은 문서에 돌아오게 안내한다. 회원 화면의 영수증 정보 저장은 후원자 단위라 재확인 뒤에만(통합 `/my/receipts` 는 기존대로).
- 후원자 화면 새 조각(`src/components/self-service/*`)은 본문 16px 이상·큰 버튼(lg)으로 만든다.

## 2026-11-09 후원금 사용 결과 보고 · 법정 서류 (3차 H)

테스트 `tests/impact-legal-2026-11-09.test.ts`. 화면 `/studio/impact`(사이드바 "사업 진행·결과 보고")·`/studio/reports/legal`("법정 서류"). 마이그레이션 `20261111200000_impact_legal_reports`.

- **사업 진행 기록** `impact_update`(캠페인, 비우면 기관 일반 후원 + 대상 기간) — DRAFT → 담당자 승인(항상) APPROVED → 승인 대기함 확인 후 배치 발송 SENT. 고치려면 `reopenImpactUpdate`(발송 대기·진행 중이면 거절). 사진은 자체 저장소 주소만 3장 + 수혜자 실사진·실명 금지 확인(`photo_rule_ack_at`). 공개 후원페이지 캠페인 상세 노출은 `public_visible`(기본 끔, APPROVED·SENT 만).
- **집행 내역 = 사용 명세는 한 표** `fund_expense`(진행 기록 연결 또는 단독). 승인된 기록에 붙은 줄은 바꾸지 않는다(보고서 숫자 근거). 지우지 않고 보관.
- **개인별 사용처를 만들지 않는다.** 보고서는 캠페인 전체 결과, 본인 기록은 머지 필드 `{{참여내역}}`(후원 N회·합계 M원)으로 따로. 판정은 `src/lib/solicitation.ts`(`personalAllocationHit`·`solicitationHit`·`numbersOutside`) 한 곳.
- **AI 초안**(`generateImpactReport`)은 숫자를 만들지 않는다 — 허용 숫자 = 기관 입력(본문·집행 표)·원천 합계(결제 PAID + 계좌이체 확정분). 어기면 `completeJson` 1회 재요청 → 실패 시 규칙 문안(`ruleReport`). mock 이면 처음부터 규칙 문안. 집행 표·모금 합계 줄은 시스템이 붙인다. 담당자 수정본도 권유 문구·개인별 사용처는 거절.
- **새 용도** `IMPACT_REPORT`·`ANNUAL_DONATION_NOTICE`(서명 없음, 기본 세트 서식, 머지 `보고제목·보고내용·참여내역·사용요약`). 정보성 — 권유 문구·링크 금지, 발송 전 점검이 이 두 용도에만 `SOLICITATION_TEXT` 경고(다른 용도 결과는 그대로). 발송 분류 `IMPACT_REPORT`·`ANNUAL_NOTICE`(관계·정보형) → 안내는 `sendRelational`(precounted=false, 7일 상한·묶음·야간).
- **대량 발송 승인** `IMPACT_REPORT_SEND`·`ANNUAL_NOTICE_SEND`(`impact-legal-approvals.ts`, `execute` → QUEUED → `runQueuedApprovals`). 확인 화면은 `/studio/inbox/approvals/[id]`(대상 수·표본 3건·비용 0원). 대상 = 참여 후원자(그 캠페인 결제·진행/일시정지 약정·계좌이체 확정분), 탈퇴·차단·월간 안내 수신 거부 제외(`filterRecipients`). 문서는 `issuePurposeDocument(notify:false)` + dedupeKey `impact:{기록}:{후원자}`·`annual-notice:{기관}:{연도}:{후원자}`.
- **연 1회 통보**는 `legal_notice_delivery (기관, 연도, 후원자)` 유니크 + 끝난 해만 + 열린 요청 있으면 새로 안 쌓음.
- **법정 서류**(`legal-reports.ts`·`legal-report-files.ts`) — **법령 서식과 대조 필요**(재무·회계 규칙 제41조의4~7 요약, 확정 전). 수입 = 결제 PAID(환불 제외, 절대 규칙 9 기준)·계좌이체 확정분(영수증 설정 무관)·현물 ISSUED(바자회 스위치 무관), 출처 열로 구분. 공개·제출용 판은 이름 없음, 내부용(마스킹 이름·발급 대장)은 사유 필수. 내려받기는 POST `/api/studio/reports/legal` + 감사로그 `LEGAL_REPORT_DOWNLOAD`. 지정 용도 외 사용 경고(`designationWarnings`)는 판정만(막지 않음). 결산 시기(기본 2~3월, `legal_report_setting`) 승인 대기함 묶음 `legal-docs`, 결과 보고서를 내려받으면 닫힌다.

## 2026-11-11 주간 운영 계획·보고 · 콘텐츠 성과 폐루프 (3차 G)

테스트 `tests/weekly-plan-content-loop-2026-11-09.test.ts`. 화면 `/studio/weekly`(·`[id]`), `/studio/goals`, `/studio/content/performance`, `/studio/content/assets`.

- **기관 목표**(`merchant_goal`, `goals.ts`)는 진행률 컬럼이 없다 — 정기후원자 수(ACTIVE 약정 후원자)·캠페인 모금액(캠페인 목표·마감 재사용, charge 기준)·봉사자 수(시작일 이후 승인·완료)·월 후원액(이번 달 결제, 계좌이체 제외)을 그때그때 센다. 속도 = 최근 4주.
- **주간 계획**(`weekly-plan.ts`, 배치 `/api/cron/weekly-plan` 1시간): 월요일 07시(KST) 이후 `weekly_plan (merchant, week_start)` 유니크로 1건. 숫자는 원천 계산만 — LLM 이 실연동이면 문장만 다듬고, 입력에 없는 숫자가 나오면(`numbersPreserved`) 버리고 규칙 문장(`generated_by=RULES`). 비용 `ai_usage.weekly_report`. 저장 값에 후원자 이름·연락처 없음.
- **계획 제안 실행은 승인 요청만**: `WEEKLY_PLAN_SLOT`(승인 → 캘린더 요일 추가, `applySlotAdd`) · `WEEKLY_PLAN_TOPIC`(승인 → 배치가 콘텐츠를 **검토 대기**로 생성, `createdBy=WEEKLY_PLAN:{승인 id}` 로 1회). 계획 승인으로 게시·발송되는 경로를 만들지 않는다. 안내 발송 제안(연말정산 등)은 기존 승인 대기함·저니 화면 링크만. 승인 대기함 묶음 `weekly-plan`.
- **월요일 보고**: 09~21시(KST) `report_claimed_at` 조건부 선점으로 1통, 템플릿 `WEEKLY_REPORT`(정보성, `ALIMTALK_TEMPLATES` — 승인 전이면 문자 대체 그대로). 받는 사람 = 기관 소유 계정 휴대폰 → 없으면 기관 정보 담당자 연락처. 기관 담당자 대상이라 `classify.ts` 의 `STAFF_INFO_TEMPLATES`(후원자 7일 상한·`sendRelational` 대상 아님). 수신 끄기 `weekly_report_setting`(꺼도 계획·콘솔 알림은 남음).
- **콘텐츠 귀속**(`content-performance.ts`): 게시 → `/go` 클릭 → 결제 건·약정 `content_item_id`. 유지 약정 = 약정 90일 뒤 ACTIVE + `recurring_run` SUCCESS 2회↑. 콘텐츠 id 가 없는 결제는 "미확인" 으로 따로 세고 배정하지 않는다. 게시 10건 이상일 때만 상위 요소(형식·주제·요일·시각·첫 문장 길이)를 `brief.wins` → 프롬프트 "잘된 것"(mock 은 `ai_cache content_wins` 저장·표시만).
- **2안 비교**(`content-variants.ts`, 설정 `ab_test_enabled`): 캘린더 슬롯 A안을 만든 직후 캡션만 다른 B안(공급자 호출·비용 없음, 월 생성 건수에는 들어감). 각각 사람 승인. 둘 다 승인 → A안 예약 플랫폼 2개↑면 하나를 B안으로, 1개면 같은 플랫폼 3시간 뒤. A안 반려 + B안 승인 → B안이 슬롯을 넘겨받음. 승인되지 않은 안은 예약하지 않는다. 수정 요청 판은 묶음을 이어받는다.
- **콘텐츠 소재**(`content_asset`, `content-assets.ts`): 비공개 저장소만(`/studio/content/assets/[id]/file`). 얼굴 여부는 담당자 체크(자동 인식 없음). 얼굴 소재는 `PORTRAIT_CONSENT`(새 용도 — 서명 필요·자동 발송 없음, 기본 세트 PORTRAIT_CONSENT 서식) 서명 요청 SENT·IN_PROGRESS·COMPLETED 와 연결해야 쓸 수 있고, 연결·승인 때마다 다시 본다(`approveContent` 가 `contentAssetsProblem` 으로 거절). 아동·이용자 기본 가림 필요, 수혜자(BENEFICIARY) 소재는 콘텐츠에 쓸 수 없다. 소재를 장면에 자동 합성하지 않는다.

## 2026-11-12 캠페인 전 과정 연결 · 기관 도입 자동 (4차 I)

테스트 `tests/campaign-onboarding-2026-11-09.test.ts`. 화면 `/studio/campaigns/new`(개설 마법사, `?mode=full` 예전 상세 폼)·`/studio/campaigns/[id]`(기간·목표 바꾸기·종료 후 처리)·`/studio/start`(도입 체크리스트·작동 점검). 마이그레이션 `20261112100000_campaign_flow_onboarding`.

- **개설 마법사**(`campaign-setup.ts` `createCampaignFromPlan`)는 캠페인 + 콘텐츠 일정 슬롯(`content_slot.status=PLANNED`, 캠페인 기간 주 N건)을 **한 트랜잭션**으로 만든다. 같은 제출은 `campaign.setup_key` 유니크로 1회. 키워드·QR 은 캠페인에 항상 붙는다(QR 은 행 없음). 콘텐츠는 `/api/cron/campaign-ops`(1시간)가 슬롯 7일 전부터 `PLANNED→GENERATING` 조건부 선점으로 만들어 **검토 대기**로만 올린다(승인해야 게시, 작성 중 캠페인은 기다림). 감사 문구는 `campaign.thanks_message`(감사 문자 치환자 규칙, 비우면 기관 기본) — 결제 성공 감사 문자에서 캠페인 문구가 먼저(`campaignThanksText`, 실패하면 예전대로).
- **종료 후 처리 방침** `campaign.after_end_policy`: GENERAL(기본 = 예전 동작, 기관 일반 후원) · REJECT(끝난 캠페인 키워드 문자는 결제 건을 만들지 않고 `CAMPAIGN_ENDED` 안내만, MO `BLOCKED`). 다른 캠페인으로 옮기는 선택지를 만들지 않는다(지정 목적 변경은 후원자가 직접). 판단은 `campaign-after-end.ts` 한 곳(결제 흐름은 이 작은 모듈만 import, 실패하면 일반 후원).
- **변경 영향 미리보기**(`campaignChangeImpact` → `applyCampaignChange`): 미리보기와 반영이 같은 계산. 반영은 캠페인 `FOR UPDATE` + 화면이 본 `updatedAt` 일치 때만. 기간 밖이 된 슬롯의 미게시 콘텐츠는 **보류**(`HELD`, 예약 게시 취소 — 지우지 않음, `autoScheduleSlotItem` 은 HELD 를 예약하지 않음), 연장은 보류 해제 + `content_plan` 규칙으로 슬롯 추가. 결과 보고 예정일은 종료일과 같은 날 수만큼 옮기고 종료하는데 없으면 오늘+30일. 목표를 모인 금액보다 올리면 `goal_reached_at` 을 지운다(새 목표 달성 이벤트 1회).
- 목표 달성(`campaign.goal_reached`) → 소비자 `campaign-goal-followup` 이 승인 요청 `CAMPAIGN_GOAL_FOLLOWUP` 만(승인 → 결과 보고 DRAFT 초안 1건, 발송 없음). 기간 70% 경과 + 진행률 < 경과 비율 × 60% → 기관 알림 1회(`pace_alert_at` 조건부) + 주간 계획 제안(최근 7일). 결과 보고 예정일이 된 끝난 캠페인(승인·발송된 결과 보고 없음) → 승인 대기함 묶음 `campaign-result-report`.
- **도입 체크리스트**(`onboarding.ts`)는 원천에서 계산 — 저장하는 것은 "해당 없음" 과 "숨기기" 뿐(`system_setting onboarding:{기관}`). 대시보드 안내는 승인 90일 안 신규 기관만.
- **서류 자동 읽기**: OCR 어댑터 `src/server/adapters/ocr/index.ts`(`recognize(buffer, mime) → { lines: [{ text, box: {page,x,y,w,h}, confidence }] }`, `OCR_PROVIDER=mock|anthropic`, 키 없으면 호출 안 함 — 형식은 다른 과제와 공용이라 바꾸지 않는다). mock 이면 업로드 대신 "연결 후 사용". 원본은 비공개 저장소, 후보(`org_doc_scan.candidates`)는 주민번호 꼴을 가린 값만, 입력칸 채우기(`/studio/profile?scan=`)만 하고 저장은 담당자.
- **시험 후원·시험 문서**는 샌드박스(`sandbox_charge`·`sandbox_message`) 규칙을 재사용한다 — `charge.is_test` 를 새로 쓰지 않는다(물리 분리라 집계·정산·영수증에 섞일 수 없음). 시험 문서는 감사장 서식 렌더·점검만(저장·발송·이용요금 차감 없음). 시험은 "작동 확인" 으로 치지 않는다.
- **작동 점검**(`readiness-checks.ts`): 준비도 항목에 원천 기록(문자 회신 단계·결제 성공·알림톡 SENT·실연동 SNS 토큰·전자문서 발송)의 마지막 시각을 붙여 "설정됨" 과 "작동 확인됨"(mock 결과 제외)을 나눈다.
- **명단 가져오기**: 같은 휴대폰 해시 = 중복(건너뜀), 이름 + 휴대폰 뒷자리가 같은 다른 번호 = 중복 후보(체크한 줄만 등록, `candidateLines`). `candidateLines` 를 주지 않는 호출은 예전 동작. 가져온 사람에게 발송하지 않는다.
- **자가 진단** `/api/cron/self-check`(매일 08:00): SNS 만료 7일 전(실연동만), 전자문서 잔액이 지난 30일 사용량 기준 7일 안 소진, MO 수신이 지난 4주 같은 요일 평균의 30% 미만(평균 20건 이상) → 기관(급감은 최고관리자도) 콘솔 알림. 같은 알림은 `self_check_alert.dedupe_key` 로 1회.
