import { prisma } from '@/server/db';

/**
 * 후원자 "받은 문서" 목록 (2026-11-09 2차 F) — 감사장·확인서(issued_document, 서명 불필요) + 약정서·신청서(agreement_document).
 * 약정서는 서명 완료본(SIGNED)과 전자서명 없이 동의 기록으로 성립한 판(NONE)만 보여 준다(요청 중·거절·만료 판은 뺀다).
 * merchantId 를 주면 그 기관 문서만(기관 후원 회원 화면). 열람 링크 만료와 무관하게 본인 문서는 다시 연다.
 */
export interface ReceivedDocument {
  kind: 'ISSUED' | 'AGREEMENT';
  id: string;
  merchantId: string;
  merchantName: string;
  title: string;
  createdAt: Date;
  /** 서명이 필요한 발급 문서(서명은 문자로 받은 서명 링크에서) */
  needsSignature: boolean;
  statusText: string | null;
  version?: number;
}

export async function receivedDocuments(payerId: string, merchantId?: string): Promise<ReceivedDocument[]> {
  const where = { payerId, ...(merchantId ? { merchantId } : {}) };
  const [issued, agreements] = await Promise.all([
    prisma.issuedDocument.findMany({ where: { ...where, archivedAt: null }, orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, merchantId: true, title: true, signature: true, status: true, createdAt: true } }),
    prisma.agreementDocument.findMany({ where: { ...where, esignStatus: { in: ['SIGNED', 'NONE'] } }, orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, merchantId: true, title: true, version: true, esignStatus: true, signedAt: true, createdAt: true } }),
  ]);
  const ids = Array.from(new Set([...issued.map((r) => r.merchantId), ...agreements.map((r) => r.merchantId)]));
  const merchants = await prisma.merchantProfile.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } });
  const nameOf = new Map(merchants.map((m) => [m.id, m.displayName]));
  const out: ReceivedDocument[] = [
    ...issued.map((r) => ({
      kind: 'ISSUED' as const, id: r.id, merchantId: r.merchantId, merchantName: nameOf.get(r.merchantId) ?? '기관', title: r.title, createdAt: r.createdAt,
      needsSignature: r.signature, statusText: r.signature ? (r.status === 'SIGNED' ? '서명 완료' : '서명 요청') : null,
    })),
    ...agreements.map((a) => ({
      kind: 'AGREEMENT' as const, id: a.id, merchantId: a.merchantId, merchantName: nameOf.get(a.merchantId) ?? '기관', title: a.title, createdAt: a.signedAt ?? a.createdAt,
      needsSignature: false, statusText: a.esignStatus === 'SIGNED' ? '서명 완료' : '동의 기록으로 성립', version: a.version,
    })),
  ];
  return out.sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime());
}
