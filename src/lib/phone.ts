/** Browser-safe phone formatting. Cryptography stays in the server utility. */
export function normalizePhone(input: string): string {
  let v = (input || '').replace(/[^0-9+]/g, '');
  if (v.startsWith('+82')) v = '0' + v.slice(3);
  else if (v.startsWith('82') && v.length > 10) v = '0' + v.slice(2);
  return v.replace(/[^0-9]/g, '');
}
export function phoneTail4(value: string): string {
  const digits = (value || '').replace(/[^0-9]/g, '');
  return digits.length >= 4 ? digits.slice(-4) : '';
}
