/**
 * 공개 화면 표시용 마스킹 유틸.
 * 후원자 표시명은 전체 노출하지 않는다.
 */
export function maskDisplayName(name: string | null | undefined): string {
  const v = (name ?? '').trim();
  if (!v) return '익명';
  if (v.length === 1) return `${v}*`;
  if (v.length === 2) return `${v[0]}*`;
  return `${v[0]}${'*'.repeat(v.length - 2)}${v[v.length - 1]}`;
}
