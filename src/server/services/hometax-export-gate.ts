import { prisma } from '@/server/db';
import { verifyPassword } from '@/server/auth';
import { kv } from '@/server/redis';
import { generateToken, tokenHash } from '@/lib/crypto';

/**
 * 홈택스 제출 명세(주민등록번호 원문 포함) 내려받기 관문.
 *
 * 예전에는 로그인한 담당자가 링크를 누르기만 하면 파일이 만들어졌다. 세션이 탈취되거나 자리를 비운
 * 사이에도 후원자 전원의 주민번호가 나갈 수 있었다. 이제는
 *   1) 비밀번호 재확인  2) 내려받는 사유  3) 하루 횟수 제한
 * 을 통과해야 5분짜리 1회용 토큰이 나오고, 다운로드 경로는 그 토큰을 소비해야만 파일을 만든다.
 */
export const HOMETAX_EXPORT_DAILY_LIMIT = 5;
export const HOMETAX_EXPORT_TOKEN_TTL_SEC = 300;
const PASSWORD_TRIES_PER_HOUR = 5;

export class ExportGateError extends Error {}

function kstDay(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
}

const tokenKey = (token: string) => `hometax-export:token:${tokenHash(token)}`;

export async function issueHometaxExportToken(input: {
  userId: string;
  merchantId: string;
  taxYear: number;
  password: string;
  reason: string;
}): Promise<string> {
  const reason = input.reason.trim();
  if (reason.length < 4) throw new ExportGateError('내려받는 사유를 4자 이상 적어 주세요. (예: 2026년 연말정산 간소화 제출)');
  if (reason.length > 100) throw new ExportGateError('사유는 100자 이내로 적어 주세요.');

  const tries = await kv.incr(`hometax-export:pw:${input.userId}`, 3600);
  if (tries > PASSWORD_TRIES_PER_HOUR) throw new ExportGateError('비밀번호를 여러 번 틀렸습니다. 1시간 뒤에 다시 시도해 주세요.');
  const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { passwordHash: true } });
  if (!user?.passwordHash) {
    throw new ExportGateError('비밀번호가 설정되지 않은 계정입니다(소셜 로그인). 계정 설정에서 비밀번호를 먼저 만들어 주세요.');
  }
  if (!(await verifyPassword(input.password, user.passwordHash))) throw new ExportGateError('비밀번호가 맞지 않습니다.');
  await kv.del(`hometax-export:pw:${input.userId}`);

  const used = await kv.incr(`hometax-export:day:${input.merchantId}:${kstDay()}`, 2 * 86400);
  if (used > HOMETAX_EXPORT_DAILY_LIMIT) {
    throw new ExportGateError(`명세 파일은 하루 ${HOMETAX_EXPORT_DAILY_LIMIT}번까지 만들 수 있습니다. 내일 다시 시도해 주세요.`);
  }

  const token = generateToken(24);
  await kv.set(
    tokenKey(token),
    JSON.stringify({ userId: input.userId, merchantId: input.merchantId, taxYear: input.taxYear, reason }),
    HOMETAX_EXPORT_TOKEN_TTL_SEC,
  );
  return token;
}

/** 토큰을 한 번만 쓰고 지운다. 다른 사용자·기관·연도의 토큰이면 거절한다. */
export async function consumeHometaxExportToken(
  token: string,
  expect: { userId: string; merchantId: string; taxYear: number },
): Promise<{ reason: string }> {
  if (!token || token.length < 16) throw new ExportGateError('내려받기 확인이 필요합니다. 화면에서 비밀번호를 다시 입력해 주세요.');
  const key = tokenKey(token);
  // 같은 토큰으로 두 요청이 동시에 와도 하나만 통과하도록 소비 표시를 먼저 선점한다.
  const claimed = await kv.setnx(`${key}:used`, '1', HOMETAX_EXPORT_TOKEN_TTL_SEC);
  const raw = claimed ? await kv.get(key) : null;
  await kv.del(key);
  if (!raw) throw new ExportGateError('내려받기 확인이 만료되었거나 이미 사용되었습니다. 다시 시도해 주세요.');
  const v = JSON.parse(raw) as { userId: string; merchantId: string; taxYear: number; reason: string };
  if (v.userId !== expect.userId || v.merchantId !== expect.merchantId || v.taxYear !== expect.taxYear) {
    throw new ExportGateError('내려받기 확인 정보가 맞지 않습니다. 다시 시도해 주세요.');
  }
  return { reason: v.reason };
}
