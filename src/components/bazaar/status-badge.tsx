import { Badge } from '@/components/ui';

type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger';

export function LabelBadge({ map, value }: { map: Record<string, { text: string; tone: Tone }>; value: string }) {
  const l = map[value] ?? { text: value, tone: 'neutral' as const };
  return <Badge tone={l.tone}>{l.text}</Badge>;
}
