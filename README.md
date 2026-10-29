# 기브싸인 GiveSign

사회복지기관에 전용 MO 번호를 제공하고, 문자후원·기관 후원페이지·캠페인과 후원 운영을 연결하는 독립 서비스입니다.

## 실행

- `1_미리보기실행.bat` 또는 `npm run preview`: 독립 내장 DB와 프로덕션 서버 실행
- `도구_수정즉시반영.bat`: 개발 중 즉시 반영
- 접속: http://localhost:3060
- 기관 테스트 로그인: `/login` → **사회복지기관 테스트 로그인**
- 최고관리자·후원자 테스트 로그인도 로컬에서 제공합니다.

## 기관 운영

- `/studio/donation-page`: 대표 배너·로고 업로드, 기관 소개, 색상, 감사 인사, 공개 설정
- `/studio/campaigns`: 캠페인 생성·수정·비공개, 모집 기간·목표금액·지원 대상·사용계획
- `/donate/[기관코드]`: 공개 기관 후원페이지
- `/donate/[기관코드]/campaigns/[캠페인ID]`: 공개 캠페인
- `/admin/fundraising`: 기관별 후원페이지와 캠페인 현황
- `/admin/mo-numbers`: 기관 MO 번호 배정

테스트 기관 예시: `/donate/GIV-8K2M`. MO 후원금은 기관 단위로 집계됩니다. 캠페인별 실적 집계는 아직 연결하지 않았으며 숫자를 임의 표시하지 않습니다.

## 독립 운영

| 항목 | 기브싸인 설정 |
|---|---|
| 앱 | 3060 |
| 내장 PostgreSQL 호환 DB | 5463 / `.givesign-pglite` |
| Docker PostgreSQL | 5462 |
| Docker Redis | 6390 |
| 빌드 캐시 | `.givesign-next` |
| 세션 쿠키 | `givesign_session` |
| Git 원격 | https://github.com/nan29077/givesign |

기존 프로젝트의 데이터·캐시를 실행에 사용하지 않습니다. 로컬은 mock 결제·문자 어댑터이며 실제 MO 개통과 결제사 계약·운영 환경 설정이 필요합니다. 테스트 로그인은 로컬 환경에서만 허용됩니다.

## 검증

- `npm run typecheck`
- `npm run build`
- `node --max-old-space-size=512 node_modules/eslint/bin/eslint.js src`
- `node node_modules/tsx/dist/cli.mjs tests/fundraising-check.ts`
- 서버 실행 후 `node e2e/givesign.mjs` (Chrome 설치 필요)

생성형 이미지 및 프롬프트는 `docs/GENERATED_ASSETS.md`에 기록했습니다.
