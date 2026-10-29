-- 자체 방송(RTMPS Ingest) 기능 제거.
-- 미디어 인프라 없이 키 발급/폐기 화면만 있던 기능이라 관련 테이블과 열거형을 정리한다.
-- 오버레이 · 후원 · 유튜브 연동 테이블은 건드리지 않는다.
--
-- stream_key 의 부분 유니크 인덱스(stream_key_active_uniq, guards_and_indexes 에서 생성)는
-- 테이블과 함께 제거되므로 별도 DROP INDEX 가 필요 없다.

-- DropForeignKey
ALTER TABLE IF EXISTS "stream_key" DROP CONSTRAINT IF EXISTS "stream_key_channel_id_fkey";

-- DropForeignKey
ALTER TABLE IF EXISTS "stream_channel" DROP CONSTRAINT IF EXISTS "stream_channel_creator_id_fkey";

-- DropTable
DROP TABLE IF EXISTS "stream_key";

-- DropTable
DROP TABLE IF EXISTS "stream_channel";

-- DropEnum
DROP TYPE IF EXISTS "stream_key_status";
