import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: '.givesign-next',
  agentRules: false,
  // 내장 DB와 함께 실행하는 로컬 Windows 빌드의 동시 워커 수를 제한한다.
  experimental: { cpus: 2 },
  /**
   * 개발 모드 좌측 하단 "N Issue" 배지 비활성화.
   *
   * 배지가 보고하던 유일한 이슈는 브라우저 확장 프로그램이 Next 내부 요소에
   * style 속성을 주입해 생기는 하이드레이션 불일치로, 앱 코드 문제가 아님을
   * 확인했다(무확장 브라우저에서는 콘솔 오류 0건).
   * 실제 런타임 오류는 배지와 무관하게 개발 오버레이(전체 화면)로 계속 표시된다.
   * 이 설정은 개발 모드에만 영향을 주며 프로덕션 빌드에는 아무 효과가 없다.
   */
  devIndicators: false,

  /**
   * Cloudflare 터널(trycloudflare.com) 등 외부 URL로 dev 서버에 접근할 때
   * Next.js 16 이 RSC 페이로드 요청을 차단해 React hydration 이 실패하는 문제 방지.
   * allowedDevOrigins 에 추가된 호스트는 dev 서버가 신뢰하는 출처로 인식한다.
   * 이 설정은 개발 모드에만 적용되며 프로덕션 빌드에는 아무 효과가 없다.
   */
  allowedDevOrigins: ['*.trycloudflare.com'],

  /**
   * 컨테이너 배포(ECS/Fargate)에서는 standalone 출력을 쓴다.
   * node_modules 전체를 이미지에 싣지 않아 이미지가 작아지고 콜드스타트가 빨라진다.
   *
   * 다만 standalone 빌드는 `next start` 로 실행할 수 없고
   * `node .next/standalone/server.js` 로 띄워야 한다.
   * 로컬 미리보기(1_미리보기실행.bat → npm run start)를 깨뜨리지 않도록
   * 빌드 시 NEXT_OUTPUT=standalone 을 준 경우에만 켠다.
   *
   *   운영 도커 빌드: NEXT_OUTPUT=standalone npm run build
   *                  → node .next/standalone/server.js
   *   로컬 미리보기 : npm run build && npm run start (지금까지와 동일)
   */
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' as const } : {}),

  /**
   * 보안 응답 헤더.
   *
   * Next.js 는 이 헤더들을 기본으로 붙이지 않는다. 그래서 예전에는 관리자·스튜디오 화면을
   * 남의 페이지에 투명한 iframe 으로 겹쳐 두고 로그인 상태의 관리자에게 승인·정지·정산 확정·
   * 권한 변경 버튼을 누르게 만드는 클릭재킹이 가능했다.
   * 서버 액션의 동일 출처 검사는 교차 출처 *요청* 을 막지만, 정상 출처 안에서 일어나는
   * *클릭* 은 막지 못한다. 프레임 자체를 거부해야 닫힌다.
   */
  async headers() {
    const base = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
      // 이 서비스는 위치·카메라·마이크를 쓰지 않는다. 확장 프로그램이 끼어드는 것도 막는다.
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
    ];

    // HTTPS 로 서비스할 때만 HSTS 를 붙인다. 로컬(http) 에 붙이면 브라우저가
    // localhost 를 https 로 강제 기억해 개발이 막힌다.
    if (process.env.NODE_ENV === 'production' && (process.env.APP_BASE_URL ?? '').startsWith('https://')) {
      base.push({ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' });
    }

    return [
      {
        // 오버레이를 제외한 모든 경로.
        // 한 경로에 규칙 두 개가 겹치면 같은 헤더가 두 줄로 나가므로,
        // 예외 경로는 매칭 단계에서 빼 둔다.
        source: '/((?!overlay/).*)',
        headers: base,
      },
      {
        /**
         * 오버레이만 예외.
         * OBS·PRISM 브라우저 소스와 스튜디오 미리보기 iframe 이 이 화면을 감싸므로
         * 프레임을 막으면 방송 화면이 나오지 않는다.
         * 대신 이 경로에는 상태를 바꾸는 조작 버튼이 없어 클릭재킹의 표적이 되지 않고,
         * 접근은 오버레이 토큰으로 따로 통제한다.
         *
         * 토큰이 URL 쿼리에 실리므로 리퍼러는 아예 보내지 않는다.
         */
        source: '/overlay/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Content-Security-Policy', value: 'frame-ancestors *' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
