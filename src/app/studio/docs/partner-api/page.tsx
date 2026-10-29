import fs from 'node:fs/promises';
import path from 'node:path';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { Card, Notice } from '@/components/ui';
import { PageHeader } from '@/components/layout/console-shell';
import { CopyButton } from '@/components/public/copy-button';
import { requireMerchant } from '@/server/auth';

export const dynamic = 'force-dynamic';

/**
 * 연동 규격서.
 *
 * 예전에는 "고객센터로 요청해 주세요" 라고만 안내하면서 파일 경로를 그대로 노출했다.
 * 사회복지기관이 스스로 열 수 있어야 연동이 막히지 않는다.
 *
 * 저장소의 문서 파일을 그대로 읽어 보여 준다. 문서를 고치면 화면도 함께 바뀐다.
 * 렌더링은 하지 않고 원문 그대로 둔다 — 마크다운 렌더러를 넣으면 코드 블록의
 * 서명 예시가 조용히 바뀔 수 있어 연동 규격서로는 위험하다.
 */
export default async function PartnerApiDocPage() {
  await requireMerchant();

  let body: string | null = null;
  try {
    body = await fs.readFile(path.join(process.cwd(), 'docs', '연동규격서_사회복지기관API.md'), 'utf8');
  } catch {
    body = null;
  }

  return (
    <>
      <Link
        href="/studio/settings?tab=api"
        className="mb-2 inline-flex items-center gap-1 text-[12.5px] font-bold text-ink-500 hover:text-ink-900"
      >
        <ChevronLeft size={15} strokeWidth={1.8} />
        후원 설정으로
      </Link>

      <PageHeader
        title="연동 규격서"
        description="사회복지기관 서버가 결제 건을 가져가 처리하고 결과를 알려주는 방법입니다."
        action={body ? <CopyButton value={body} label="전체 복사" /> : undefined}
      />

      {body === null ? (
        <Notice tone="warning" title="문서를 불러오지 못했습니다">
          규격서 파일을 찾을 수 없습니다. 고객센터로 문의해 주시면 파일로 보내 드립니다.
        </Notice>
      ) : (
        <Card>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[12.5px] leading-relaxed text-ink-800">
            {body}
          </pre>
        </Card>
      )}
    </>
  );
}
