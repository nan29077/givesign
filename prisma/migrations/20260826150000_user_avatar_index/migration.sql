-- 모든 계정에 50종 기본 프로필 캐릭터 중 하나를 한 번만 무작위 배정한다.
ALTER TABLE "app_user"
ADD COLUMN "avatar_index" INTEGER NOT NULL
DEFAULT (floor((random() * (50)::double precision)))::integer;

ALTER TABLE "app_user"
ADD CONSTRAINT "app_user_avatar_index_check"
CHECK ("avatar_index" >= 0 AND "avatar_index" < 50);
