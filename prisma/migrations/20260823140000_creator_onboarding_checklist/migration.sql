-- ---------------------------------------------------------------------------
-- 신규 사회복지기관 온보딩 체크리스트 (수동 체크 항목)
--
-- 체크리스트 5개 중 3개(유튜브 연결 / 후원 번호 배정 / 오버레이 효과 설정)는
-- 기존 표에서 그대로 판별할 수 있지만, 아래 두 개는 서버가 알 수 없어
-- 사회복지기관가 직접 [완료했어요] 를 눌러 표시한다.
--   - onboarding_obs_linked : OBS/프리즘에 오버레이 URL 을 등록했는지
--   - onboarding_test_done  : 테스트 후원으로 화면 표시를 확인했는지
-- ---------------------------------------------------------------------------

ALTER TABLE "creator_profile"
  ADD COLUMN IF NOT EXISTS "onboarding_obs_linked" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "onboarding_test_done" BOOLEAN NOT NULL DEFAULT false;
