# 기브싸인 개발 가이드

사회복지기관 전용 MO 문자후원 서비스. 원격 https://github.com/nan29077/givesign.
앱 3060, 내장 DB 5463(.givesign-pglite), Docker PostgreSQL 5462, Redis 6390.
기관 /studio, 페이지 설정 /studio/donation-page, 캠페인 /studio/campaigns.
공개 /donate/[code], 캠페인 /donate/[code]/campaigns/[id].
페이지와 캠페인은 SystemSetting의 기관별 키에 영구 저장한다.
미연동 외부 결제와 문자는 mock을 명시한다. 중복 결제 방지와 append-only 정산 원장 및 암호화를 유지한다.
내부 Merchant/Charge 모델은 호환을 위해 유지한다.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
