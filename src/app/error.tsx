'use client';

/**
 * 화면 오류 안내.
 *
 * 운영: "잠시 후 다시 시도 · 고객센터" 만 보여 준다. 내부 파일명·환경변수명·오류 원문을 노출하지 않는다(점검 F).
 * 개발: 로컬에서 가장 흔한 원인은 데이터베이스 미실행이므로 점검 체크리스트와 오류 원문을 함께 보여 준다.
 *
 * 에러 바운더리에서는 훅을 쓰지 않는다(CLAUDE.md). process.env.NODE_ENV 는 빌드 때 치환되므로
 * 운영 번들에는 개발용 체크리스트가 남지 않는다.
 */
const IS_DEV = process.env.NODE_ENV !== 'production';

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
    <div className="flex min-h-dvh items-center justify-center bg-[#f7f5ef] p-6">
      <div className="w-full max-w-[520px] rounded-[20px] bg-white p-6 shadow-[0_2px_8px_rgba(23,22,26,0.05),0_12px_32px_rgba(23,22,26,0.06)]">
        <h1 className="text-[18px] font-extrabold text-ink-900">화면을 불러오지 못했습니다</h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-500">
          {IS_DEV
            ? looksLikeDb
              ? '데이터베이스에 연결하지 못했습니다. 아래 항목을 확인해 주세요.'
              : '일시적인 오류일 수 있습니다. 다시 시도해 보시고, 계속되면 아래 항목을 확인해 주세요.'
            : '일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요. 문제가 계속되면 고객센터로 알려 주세요.'}
        </p>
        {!IS_DEV && error?.digest ? (
          <p className="mt-2 text-[12px] text-ink-400">오류 번호 {error.digest}</p>
        ) : null}

        {IS_DEV ? (
          <>
            <ol className="mt-4 space-y-2 text-[13px] leading-relaxed text-ink-700">
              <li className="rounded-xl bg-brand-50 px-3 py-2.5 text-brand-800">
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
            {message ? (
              <pre className="mt-4 overflow-x-auto rounded-xl bg-ink-50 p-3 text-[11.5px] leading-relaxed text-ink-500">
                {message}
              </pre>
            ) : null}
          </>
        ) : null}

        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={reset}
            className="h-11 flex-1 rounded-xl bg-brand-400 px-4 text-[15px] font-semibold text-ink-900 hover:bg-brand-500"
          >
            다시 시도
          </button>
          <a
            href={IS_DEV ? '/api/health' : '/support'}
            className="flex h-11 items-center justify-center rounded-xl border border-ink-200 px-4 text-[15px] font-semibold text-ink-900"
          >
            {IS_DEV ? '상태 확인' : '고객센터'}
          </a>
        </div>
      </div>
    </div>
  );
}
