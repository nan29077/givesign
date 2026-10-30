/** MO routing keys contain digits only; display uses the contracted 1588-1234-1234 form. */
export function normalizeMoNumber(value: string): string {
  return /^[\d\s-]+$/.test(value.trim()) ? value.replace(/\D/g, '') : '';
}
export const isValidMoNumber = (value: string) => /^1588\d{8}$/.test(normalizeMoNumber(value));
export function formatMoNumber(value: string): string {
  const n = value.replace(/\D/g, '');
  if (/^1588\d{8}$/.test(n)) return `${n.slice(0, 4)}-${n.slice(4, 8)}-${n.slice(8)}`;
  // Historical numbers are displayed without changing their routing identity.
  if (/^1[568]\d{9}$/.test(n)) return `${n.slice(0, 4)}-${n.slice(4, 8)}-${n.slice(8)}`;
  if (/^050\d{7,10}$/.test(n)) return `${n.slice(0, 4)}-${n.slice(4, -4)}-${n.slice(-4)}`;
  if (/^1\d{7}$/.test(n)) return `${n.slice(0, 4)}-${n.slice(4)}`;
  return value;
}
