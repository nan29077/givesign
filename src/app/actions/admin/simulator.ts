'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/server/db';
import { writeAudit } from '@/server/auth';
import { env, isLocal } from '@/lib/env';
import { normalizePhone } from '@/lib/crypto';
import { mockMoAdapter } from '@/server/adapters/mo';
import { handleMoInbound } from '@/server/services/charge-flow';
import { moResultLabel, chargeStatusLabel } from '@/lib/labels';
import type { AdminActionState } from '@/components/admin/state';
import { run, text, optText } from './shared';

/**
 * MO 시뮬레이터.
 * 실제 MO 사업자 연동 전에 수신 → 결제 → 처리 결과 흐름을 검증하기 위한 개발/검수 도구다.
 * 운영 환경(APP_ENV=prod)에서는 어떤 경우에도 실행되지 않는다.
 */
export async function runMoSimulation(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    if (!isLocal) throw new Error('이 환경에서는 MO 시뮬레이터를 사용할 수 없습니다. (APP_ENV=local 전용)');
    if (env.mo.provider !== 'mock') {
      throw new Error(`MO_PROVIDER=${env.mo.provider} 상태에서는 mock 시뮬레이터를 실행할 수 없습니다.`);
    }

    const to = text(fd, 'to').replace(/[^0-9]/g, '');
    const fromRaw = text(fd, 'from');
    const content = text(fd, 'content');
    const messageId = optText(fd, 'messageId') ?? `SIM${Date.now()}${Math.floor(Math.random() * 1000)}`;

    if (!to) throw new Error('수신번호를 선택해 주세요.');
    const from = normalizePhone(fromRaw);
    if (!/^01[0-9]{8,9}$/.test(from)) throw new Error('발신 휴대전화번호 형식을 확인해 주세요. (예: 010-1234-5678)');
    if (content.length < 1) throw new Error('문자 내용을 입력해 주세요.');
    if (content.length > 500) throw new Error('문자 내용은 500자 이내로 입력해 주세요.');

    const inbound = mockMoAdapter.parse({
      messageId,
      to,
      from,
      text: content,
      type: Buffer.byteLength(content, 'utf8') > 90 ? 'LMS' : 'SMS',
      receivedAt: new Date().toISOString(),
    });

    const result = await handleMoInbound(inbound);

    const charge = result.chargeId
      ? await prisma.charge.findUnique({
          where: { id: result.chargeId },
          select: { transactionNo: true, amount: true, status: true },
        })
      : null;

    await writeAudit({
      adminUserId: admin.id,
      action: 'MO_SIMULATION_RUN',
      targetType: 'MoInboundMessage',
      targetId: result.moMessageId,
      after: {
        providerMessageId: messageId,
        receivedNumber: to,
        result: result.result,
        chargeId: result.chargeId ?? null,
        appEnv: env.appEnv,
      },
    });

    revalidatePath('/admin/simulator');
    revalidatePath('/admin/mo-messages');
    revalidatePath('/admin/mt-messages');

    return {
      message: `시뮬레이션을 실행했습니다. 처리 결과: ${moResultLabel[result.result].text}`,
      detail: {
        result: `${moResultLabel[result.result].text} (${result.result})`,
        providerMessageId: messageId,
        moMessageId: result.moMessageId ?? '-',
        transactionNo: charge?.transactionNo ?? '-',
        chargeStatus: result.status ? `${chargeStatusLabel[result.status].text} (${result.status})` : '-',
        systemMessage: result.message,
      },
    };
  });
}
