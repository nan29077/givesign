import { env, isLocal } from '@/lib/env';
import { generateToken } from '@/lib/crypto';
import { AdapterNotConfiguredError, type AdapterInfo, type ProviderResult } from '../types';

/**
 * 전자서명 어댑터 (페이싸인 · 모두싸인 등).
 *
 * 약정서는 전자서명 없이도 "동의 기록(시각·IP·약관 버전) + 내용 해시" 로 성립한다.
 * 기관이 서명 이미지가 들어간 서류를 원하거나, 계좌 CMS 출금동의처럼 법이 정한 방식이 필요할 때
 * 이 어댑터로 서명 요청을 보낸다.
 *
 * 결과 수신(콜백) 라우트는 아직 없다. 실연동 공급자를 붙일 때 서명 검증을 갖춘 콜백 라우트를 만들고
 * 그 안에서 completeESign 을 호출해야 한다. 지금 결과는 로컬 모의 서명 화면에서만 반영되며,
 * 결과가 오지 않은 요청은 정리 배치가 ESIGN_REQUEST_TTL_DAYS 뒤 EXPIRED 로 닫는다.
 *
 * mock 은 실제 서명 요청을 보내지 않는다. 로컬에서만 열리는 모의 서명 화면(/mock/esign/[id])에서
 * 사람이 직접 [서명]/[거절] 을 눌러야 결과가 난다 — 자동으로 "서명 완료" 를 만들지 않는다(절대 규칙 2).
 *
 * internal(ESIGN_PROVIDER=internal)은 기브싸인 전자문서 센터(EDocEnvelope)로 서명을 받는다. 외부 계약이 필요 없는
 * 실제 동작이라 mock 이 아니다(운영 부팅 점검 통과). 요청은 용도별 문서 발송(issuePurposeDocument)으로 봉투를 만들고
 * — 서명자 1명 = 후원자, 이용요금 차감 규칙 그대로 — requestId 는 봉투 id 다. 봉투가 완료·거절되면
 * edoc.ts 가 syncIssuedFromEnvelope → completeESign(봉투 id) 으로 약정서에 반영한다(연결 키: agreement_document.esign_request_id = edoc_envelope.id).
 */

export interface ESignRequest {
  docNo: string;
  title: string;
  /** 서명자 (복호화된 휴대폰 번호. 로그에 남기지 않는다) */
  signerPhone: string;
  signerName: string;
  /** 서명 화면에 보여 줄 본문(서식 렌더 결과) */
  body: string;
  contentHash: string;
  /** internal 공급자용: 누구의 어떤 문서인지 (약정서 id·기관·후원자·용도·머지 값) */
  internal?: {
    merchantId: string;
    payerId: string;
    agreementDocId: string;
    purpose: 'SUPPORT_AGREEMENT' | 'VOLUNTEER_APPLICATION' | 'RECURRING_CHANGE';
    context: import('@/server/services/purpose-documents').MergeContext;
  };
}

export interface ESignRequestResult {
  requestId: string;
  /** 서명자에게 보낼 서명 화면 주소 */
  signUrl: string;
}

export interface ESignAdapter {
  info(): AdapterInfo;
  request(req: ESignRequest): Promise<ProviderResult<ESignRequestResult>>;
}

export const mockESignAdapter: ESignAdapter = {
  info() {
    return { provider: 'mock', mode: 'mock', missingCredentials: [] };
  },
  async request() {
    const requestId = `ESMOCK${generateToken(9).replace(/[^0-9A-Za-z]/g, '').slice(0, 12)}`;
    return {
      ok: true,
      data: { requestId, signUrl: `${env.baseUrl}/mock/esign/${requestId}` },
      latencyMs: 3,
    };
  },
};

export const internalESignAdapter: ESignAdapter = {
  info() {
    return { provider: 'internal', mode: 'live', missingCredentials: [] };
  },
  async request(req) {
    const started = Date.now();
    const i = req.internal;
    if (!i) return { ok: false, code: 'BAD_REQUEST', message: '내부 전자서명 요청에 기관·후원자 정보가 없습니다.' };
    const { issuePurposeDocument, agreementSignDedupeKey } = await import('@/server/services/purpose-documents');
    const r = await issuePurposeDocument({
      merchantId: i.merchantId,
      purpose: i.purpose,
      payerId: i.payerId,
      context: i.context,
      subject: { type: 'agreement_document', id: i.agreementDocId },
      dedupeKey: agreementSignDedupeKey(i.agreementDocId),
    });
    if (!r.ok) return { ok: false, code: r.blocked ?? 'FAILED', message: r.reason, latencyMs: Date.now() - started };
    const { prisma } = await import('@/server/db');
    const row = await prisma.issuedDocument.findUnique({ where: { id: r.issuedId }, select: { envelopeId: true } });
    if (!row?.envelopeId) return { ok: false, code: 'NO_ENVELOPE', message: '서명 요청 봉투를 찾지 못했습니다.', latencyMs: Date.now() - started };
    return {
      ok: true,
      data: { requestId: row.envelopeId, signUrl: `${env.baseUrl}/my/agreements/${i.agreementDocId}` },
      latencyMs: Date.now() - started,
    };
  },
};

function notConfigured(provider: string): ESignAdapter {
  return {
    info() {
      return { provider, mode: 'live', missingCredentials: [`${provider.toUpperCase()}_API_KEY 연동 구현`] };
    },
    async request() {
      const err = new AdapterNotConfiguredError(provider, [`${provider.toUpperCase()}_API_KEY`]);
      return { ok: false, code: 'NOT_CONFIGURED', message: err.message };
    },
  };
}

export function getESignAdapter(): ESignAdapter {
  switch (env.automation.esignProvider) {
    case 'mock':
      return mockESignAdapter;
    case 'internal':
      return internalESignAdapter;
    default:
      return notConfigured(env.automation.esignProvider);
  }
}

/** 모의 서명 화면을 열어도 되는지 (로컬 + mock 공급자) */
export function mockESignPageAllowed(): boolean {
  return isLocal && env.automation.esignProvider === 'mock';
}
