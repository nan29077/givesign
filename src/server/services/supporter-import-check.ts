import { prisma } from '@/server/db';
import { maskPhone, phoneHash } from '@/lib/crypto';

/**
 * 명단 가져오기 — 중복 후보 확인 (2026-11-12 4차 I2-3).
 *
 * 같은 휴대폰(해시)은 지금처럼 "중복" 으로 건너뛴다. 그 밖에 **이름 + 휴대폰 뒷자리 4개**가 같은데 번호가 다른 사람(번호를 바꾼 같은 사람일 수 있음)을
 * "중복 후보" 로 알려 담당자가 줄마다 등록할지 고르게 한다. 비교 대상: 이 기관 명단(supporter_contact)·이 기관 후원자(표시 이름)·같은 파일의 앞줄.
 * 화면에는 마스킹 번호만 보인다. 가져온 사람에게 아무것도 보내지 않는다.
 */

export interface CandidateInput {
  line: number;
  name: string;
  phone: string;
}

export interface CandidateHit {
  line: number;
  /** 겹친 쪽 설명(마스킹) */
  matchedWith: string;
}

const tail4 = (masked: string) => masked.replace(/\D/g, '').slice(-4);
const normName = (n: string) => n.normalize('NFKC').replace(/\s+/g, '');

export async function importDuplicateCandidates(merchantId: string, rows: CandidateInput[]): Promise<Map<number, CandidateHit>> {
  const out = new Map<number, CandidateHit>();
  if (rows.length === 0) return out;
  const names = [...new Set(rows.map((r) => r.name))];
  const [contacts, links] = await Promise.all([
    prisma.supporterContact.findMany({ where: { merchantId, name: { in: names } }, select: { name: true, phoneHash: true, phoneMasked: true } }),
    prisma.payerMerchantLink.findMany({ where: { merchantId, payer: { displayName: { in: names } } }, select: { payer: { select: { displayName: true, phoneHash: true, phoneMasked: true } } } }),
  ]);
  const known: Array<{ key: string; hash: string; label: string }> = [
    ...contacts.map((c) => ({ key: `${normName(c.name)}:${tail4(c.phoneMasked)}`, hash: c.phoneHash, label: `기관 명단 ${c.name} (${c.phoneMasked})` })),
    ...links.filter((l) => l.payer.displayName).map((l) => ({ key: `${normName(l.payer.displayName!)}:${tail4(l.payer.phoneMasked)}`, hash: l.payer.phoneHash, label: `후원자 ${l.payer.displayName} (${l.payer.phoneMasked})` })),
  ];
  const seen: Array<{ key: string; hash: string; label: string }> = [];
  for (const r of rows) {
    const hash = phoneHash(r.phone);
    const masked = maskPhone(r.phone);
    const key = `${normName(r.name)}:${tail4(masked)}`;
    const hit = known.find((k) => k.key === key && k.hash !== hash) ?? seen.find((k) => k.key === key && k.hash !== hash);
    if (hit) out.set(r.line, { line: r.line, matchedWith: hit.label });
    seen.push({ key, hash, label: `이 파일 앞줄 ${r.name} (${masked})` });
  }
  return out;
}
