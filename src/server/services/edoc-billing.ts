import { prisma } from '@/server/db';
import { EDOC_POLICY_KEY, EDOC_POLICY_DEFAULT, edocPolicySchema, edocAccountKey, edocAccountSchema } from '@/lib/edoc-billing';
export async function getEDocPolicy() {
  const row = await prisma.systemSetting.findUnique({ where: { key: EDOC_POLICY_KEY } });
  const p = edocPolicySchema.safeParse(row?.value);
  return p.success ? p.data : EDOC_POLICY_DEFAULT;
}
export async function getEDocAccount(merchantId: string) {
  const policy = await getEDocPolicy();
  const row = await prisma.systemSetting.upsert({ where: { key: edocAccountKey(merchantId) }, update: {}, create: { key: edocAccountKey(merchantId), value: { balance: 0, trialRemaining: policy.trialQuota, monthlyRemaining: 0, monthlyUntil: null, totalUsed: 0 } } });
  return edocAccountSchema.parse(row.value);
}
