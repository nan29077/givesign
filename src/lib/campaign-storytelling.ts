import type { CampaignCard } from './fundraising';

/** 참고 캠페인의 편집 흐름만 적용한다. 사례·수치·문구는 기관이 입력한 자료로 채운다. */
export const CAMPAIGN_STORY_FLOW = '핵심 메시지 → 사연 → 필요한 도움 → 후원으로 만드는 변화 → 사용 계획 → 참여 안내';

export function campaignStoryCards(input: {
  title: string; summary: string; story: string; usagePlan: string; imageUrl?: string;
}): CampaignCard[] {
  const paragraphs = input.story.trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const card = (eyebrow: string, title: string, body: string, theme: CampaignCard['theme'], imageUrl = ''): CampaignCard => ({
    eyebrow, title: title.slice(0, 100), body: body.slice(0, 1500), theme, imageUrl,
    alt: imageUrl ? title.slice(0, 200) : '', layout: imageUrl ? 'editorial' : 'text',
  });
  return [
    card('함께 만드는 변화', input.title.trim() || '이웃의 내일을 함께 지켜 주세요', input.summary.trim() || '이 캠페인이 전하고 싶은 한 문장을 적어 주세요.', 'cream', input.imageUrl),
    card('우리 이웃의 이야기', '도움이 필요한 일상에\n귀 기울여 주세요', paragraphs[0] || '지원이 필요한 이웃의 일상과 현재 상황을 적어 주세요. 개인을 알아볼 수 있는 정보는 제외해 주세요.', 'white'),
    card('지금 필요한 도움', '이 이야기가\n이어질 수 있도록', paragraphs[1] || input.summary.trim() || '현재 어떤 어려움이 있고, 왜 도움이 필요한지 확인된 사실로 설명해 주세요.', 'peach'),
    card('후원으로 만드는 변화', '함께하면\n달라질 내일', paragraphs.slice(2).join('\n\n') || '후원을 통해 지원할 활동과 기대하는 변화를 적어 주세요. 아직 일어나지 않은 일을 완료된 성과처럼 표현하지 마세요.', 'green'),
    card('후원금 사용 계획', '보내주신 마음은\n이렇게 쓰입니다', input.usagePlan.trim() || '지원 항목과 사업 일정, 예산 등 기관이 확인한 사용 계획을 적어 주세요.', 'cream'),
    card('함께해 주세요', '오늘의 마음을\n이웃의 내일로', '아래 후원하기에서 캠페인에 참여해 주세요.\n보내주신 응원을 소중히 전하겠습니다.', 'green'),
  ];
}
