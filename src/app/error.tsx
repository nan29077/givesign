'use client';

/**
 * 화면 오류 안내.
 * 로컬에서 가장 흔한 원인은 데이터베이스 미실행이므로 체크리스트를 함께 보여준다.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const message = error?.message ?? '';
  const looksLikeDb =
    /database|prisma|ECONNREFUSED|connect|P1000|P1001|P2021|authentication|can't reach|relation .* does not exist/i.test(message);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-[#f6f5fb] p-6">
      <div className="w-full max-w-[520px] rounded-[20px] bg-white p-6 shadow-[0_2px_8px_rgba(19,26,58,0.05),0_12px_32px_rgba(19,26,58,0.06)]">
        <h1 className="text-[18px] font-extrabold text-[#131a3a]">화면을 불러오지 못했습니다</h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-[#5a628c]">
          {looksLikeDb
            ? '데이터베이스에 연결하지 못했습니다. 아래 항목을 확인해 주세요.'
            : '일시적인 오류일 수 있습니다. 다시 시도해 보시고, 계속되면 아래 항목을 확인해 주세요.'}
        </p>

        <ol className="mt-4 space-y-2 text-[13px] leading-relaxed text-[#2c3563]">
          <li className="rounded-xl bg-[#f2efff] px-3 py-2.5 text-[#5836d6]">
            <span className="font-bold">간편 미리보기 사용 시:</span> 열려 있는 기브싸인 서버 창을 모두 닫고{' '}
            <span className="font-bold">1_미리보기실행.bat</span> 하나만 다시 실행해 주세요.
          </li>
          <li>
            <span className="font-bold">1.</span> 별도 PostgreSQL 방식이라면 <span className="font-bold">도구_DB시작.bat</span> 을 실행해
            PostgreSQL 컨테이너가 켜져 있는지 확인
          </li>
          <li>
            <span className="font-bold">2.</span> <span className="font-bold">도구_최초설치.bat</span> 을 실행해
            마이그레이션과 시드가 끝났는지 확인
          </li>
          <li>
            <span className="font-bold">3.</span> 직접 설치한 PostgreSQL 을 쓰신다면{' '}
            <span className="font-bold">.env</span> 의 DATABASE_URL 확인
          </li>
          <li>
            <span className="font-bold">4.</span> <span className="font-bold">도구_환경점검.bat</span> 을 실행하면
            원인을 자동으로 점검합니다
          </li>
        </ol>

        {process.env.NODE_ENV !== 'production' && message ? (
          <pre className="mt-4 overflow-x-auto rounded-xl bg-[#f6f5fb] p-3 text-[11.5px] leading-relaxed text-[#5a628c]">
            {message}
          </pre>
        ) : null}

        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={reset}
            className="h-11 flex-1 rounded-xl bg-[#6c4cf1] px-4 text-[15px] font-semibold text-white hover:bg-[#5836d6]"
          >
            다시 시도
          </button>
          <a
            href="/api/health"
            className="flex h-11 items-center justify-center rounded-xl border border-[#dcdeeb] px-4 text-[15px] font-semibold text-[#131a3a]"
          >
            상태 확인
          </a>
        </div>
      </div>
    </div>
  );
}
