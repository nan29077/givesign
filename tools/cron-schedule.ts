/**
 * 배치 등록 안내 출력 (2026-11-13 점검 A-H1).
 *
 *   npx tsx tools/cron-schedule.ts            # 표
 *   npx tsx tools/cron-schedule.ts --aws      # EventBridge Scheduler 등록 명령(aws scheduler create-schedule) 초안
 *
 * 원천은 src/server/cron-registry.ts 한 곳이다. 주기를 바꾸면 이 출력으로 다시 등록한다.
 * AWS 에서는 서버의 CRON_RUNNER=external 로 내장 실행기를 끄고 이 명령으로 등록한다(대상: API 목적지 + Bearer CRON_SECRET).
 * PC 운영은 아무것도 등록하지 않아도 된다(CRON_RUNNER=internal 기본 — 서버가 같은 주기로 부른다).
 */
import { CRON_JOBS } from '../src/server/cron-registry';

const aws = process.argv.includes('--aws');
if (!aws) {
  console.log('이름\t주기(KST)\tEventBridge 식(UTC)\t경로');
  for (const j of CRON_JOBS) console.log(`${j.name}\t${j.schedule}\t${j.eventBridge}\t${j.path}`);
} else {
  console.log('# 대상(target)은 미리 만든 EventBridge API destination(ARN) 으로 바꾼다. 헤더 Authorization: Bearer ${CRON_SECRET}');
  for (const j of CRON_JOBS) {
    const expr = j.eventBridge.startsWith('rate(') || j.eventBridge.startsWith('cron(') ? j.eventBridge.split(' ×')[0] : j.eventBridge;
    console.log(
      `aws scheduler create-schedule --name givesign-${j.name} --schedule-expression "${expr}" --flexible-time-window Mode=OFF ` +
        `--target '{"Arn":"<API_DESTINATION_ARN>","RoleArn":"<ROLE_ARN>","HttpParameters":{"PathParameterValues":[],"HeaderParameters":{},"QueryStringParameters":{}},"Input":"${j.path}"}'`,
    );
  }
  console.log('# emma-mo 는 15초 주기라 rate(1 minute) 로 등록하고 오프셋 4개(0·15·30·45초)를 따로 만든다(EMMA_ENABLED 일 때만).');
}
