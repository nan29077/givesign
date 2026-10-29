'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { startRegistration, completeRegistration } from '@/server/services/payer-registration';
import { getSessionUser } from '@/server/auth';
import { prisma } from '@/server/db';
import type { ConsentType, PaymentMethodKind } from '@/generated/prisma/enums';
import { clientIpFrom } from '@/server/rate-limit';

/**
 * 후원자 계좌 등록 서버 액션.
 * - 결제창(현재는 Mock)으로 리다이렉트하는 진입점과, 결제창 복귀 처리 두 가지를 제공한다.
 * - 실패 시 임의로 "성공"으로 위장하지 않고 사유를 그대로 화면에 전달한다.
 */

async function requestMeta() {
  const h = await headers();
  return {
    ip: clientIpFrom((name) => h.get(name)) ?? undefined,
    userAgent: h.get('user-agent') ?? undefined,
  };
}

export interface ConsentPayload {
  type: ConsentType;
  agreed: boolean;
}

export interface ActionError {
  ok: false;
  message: string;
}

/** 동의 저장 → 결제 등록 세션 생성 → 결제창으로 이동 */
export async function startRegistrationAction(
  token: string,
  consents: ConsentPayload[],
  // 결제수단 종류. 카드 빌링키는 구조만 준비되어 있고 화면에서는 아직 계좌만 넘긴다.
  method: PaymentMethodKind = 'ACCOUNT',
  // 후원 내역에 표시될 이름(선택). 빈 문자열이면 설정하지 않은 것으로 본다.
  nickname = '',
  // SNS 플랫폼(선택). 닉네임과 세트로 저장된다.
  snsPlatform?: string,
): Promise<ActionError | void> {
  const meta = await requestMeta();

  let redirectUrl: string | null = null;
  try {
    const res = await startRegistration({
      token,
      consents,
      method,
      nickname,
      snsPlatform,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    redirectUrl = res.redirectUrl;
  } catch (e) {
    return { ok: false, message: (e as Error).message || '계좌 등록을 시작하지 못했습니다.' };
  }

  // redirect() 는 내부적으로 예외를 던지므로 반드시 try 블록 밖에서 호출한다.
  redirect(redirectUrl);
}

export interface CompleteResult {
  ok: boolean;
  message?: string;
  method?: PaymentMethodKind;
  bankName?: string | null;
  accountTail4?: string | null;
  cardIssuer?: string | null;
  cardTail4?: string | null;
}

/** 결제창 복귀 처리. 성공 시 보안링크는 소비되어 다시 사용할 수 없다. */
export async function completeRegistrationAction(input: {
  token: string;
  registrationId: string;
  providerPayload: Record<string, string>;
}): Promise<CompleteResult> {
  const meta = await requestMeta();
  try {
    const res = await completeRegistration({
      token: input.token,
      registrationId: input.registrationId,
      providerPayload: input.providerPayload,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    // 로그인 상태에서 계좌 등록을 마쳤다면 후원자 프로필을 계정에 자동 연결한다.
    // (연결돼 있어야 마이페이지에서 결제·후원 내역을 볼 수 있다)
    //
    // 다만 **번호가 같을 때만** 붙인다. 이 링크는 로그인과 무관하게 열리므로,
    // 남이 만든 등록 링크를 로그인한 사람이 열게 만들면(로그인 CSRF) 그 사람 계정에
    // 남의 전화번호 프로필이 붙는다. 그러면 그 계정으로 남의 후원 내역이 보이고,
    // 반대로 그 번호의 진짜 주인은 자기 프로필을 자기 계정에 연결하지 못한다.
    //
    // 계정에 인증된 번호가 없으면 자동 연결하지 않는다. 마이페이지에서 번호 인증을
    // 거쳐 직접 연결하면 된다(phone-link.ts — 인증번호로 소유를 확인하는 경로).
    try {
      const user = await getSessionUser();
      if (user && res.payerId) {
        const [account, payer] = await Promise.all([
          prisma.user.findUnique({ where: { id: user.id }, select: { phoneHash: true } }),
          prisma.payerProfile.findUnique({ where: { id: res.payerId }, select: { phoneHash: true } }),
        ]);
        const sameOwner = Boolean(account?.phoneHash) && account!.phoneHash === payer?.phoneHash;
        if (sameOwner) {
          const alreadyLinked = await prisma.payerProfile.findUnique({
            where: { userId: user.id },
            select: { id: true },
          });
          if (!alreadyLinked) {
            await prisma.payerProfile.updateMany({
              where: { id: res.payerId, userId: null },
              data: { userId: user.id },
            });
          }
        }
      }
    } catch {
      // 연결 실패가 계좌 등록 성공을 뒤집지 않는다. 마이페이지에서 수동 연결 가능.
    }

    return {
      ok: true,
      method: res.method,
      bankName: res.bankName,
      accountTail4: res.accountTail4,
      cardIssuer: res.cardIssuer,
      cardTail4: res.cardTail4,
    };
  } catch (e) {
    return { ok: false, message: (e as Error).message || '계좌 등록을 완료하지 못했습니다.' };
  }
}
