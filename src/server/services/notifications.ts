import { prisma } from '@/server/db';
import { newId } from '@/lib/id';

export interface NotificationInput {
  userId: string;
  title: string;
  body: string;
  linkUrl?: string | null;
}

export async function notifyUser(input: NotificationInput) {
  return prisma.notification.create({
    data: {
      id: newId(),
      userId: input.userId,
      channel: 'IN_APP',
      title: input.title.slice(0, 120),
      body: input.body.slice(0, 500),
      linkUrl: input.linkUrl ?? null,
    },
  });
}

export async function notifySuperAdmins(input: Omit<NotificationInput, 'userId'>) {
  const admins = await prisma.adminProfile.findMany({
    where: { permission: 'SUPER_ADMIN', user: { status: 'ACTIVE' } },
    select: { userId: true },
  });
  if (admins.length === 0) return;

  await prisma.notification.createMany({
    data: admins.map(({ userId }) => ({
      id: newId(),
      userId,
      channel: 'IN_APP' as const,
      title: input.title.slice(0, 120),
      body: input.body.slice(0, 500),
      linkUrl: input.linkUrl ?? null,
    })),
  });
}
