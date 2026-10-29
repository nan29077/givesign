import type { ApiCategory } from './types';

/**
 * 사회복지기관 API 문서 레지스트리 — 단일 원천.
 *
 * 화면(`/studio/docs`), 누락 검사 테스트, 앞으로 만들 OpenAPI 문서가 모두 이 배열을 읽는다.
 * 문서용 사본을 따로 두면 반드시 어긋나므로 한 벌만 둔다.
 *
 * 상태 표기 (사용자 결정 2026-09-05)
 *  - LIVE    지금 호출하면 동작한다
 *  - BETA    동작하지만 규격이 바뀔 수 있다
 *  - PLANNED 아직 없다. 규격은 예고다 — 그래도 문서에 미리 공개한다
 */
export const API_CATEGORIES: ApiCategory[] = [
  // =========================================================== 01 시작하기
  {
    slug: 'start',
    order: 1,
    title: '시작하기',
    summary: '연동 순서와 역할 분담. 처음이라면 여기부터.',
    status: 'LIVE',
    intro: [
      '기브싸인 사회복지기관 API 는 사회복지기관 서버가 결제 건을 가져가 처리하고 결과를 알려주는 방식으로 시작합니다. 수신 서버를 두지 않아도 연동할 수 있습니다.',
      '연동은 선택입니다. API 를 붙이지 않아도 후원 처리 화면에서 지급 처리와 배송 등록을 모두 할 수 있습니다.',
    ],
    sections: [
      {
        heading: '역할 분담',
        body: [
          '기브싸인가 하는 일 — 후원자에게서 결제를 받고, 결제 결과를 확정하고, 정산합니다. 문자(MO 수신·MT 발송)는 기브싸인가 처리합니다.',
          '사회복지기관이 하는 일 — 결제된 건을 자기 서비스에 반영합니다. 후원금를 적립하거나, 상품을 발송하거나, 컨텐츠를 지급합니다. 반영이 끝나면 기브싸인에 알려줍니다.',
          '후원금를 발행하는 주체는 사회복지기관입니다. 기브싸인는 결제와 정산까지만 책임집니다.',
        ],
      },
      {
        heading: '연동 순서',
        body: [
          '1. 후원 설정 → 연동 탭에서 API 키를 발급합니다. 키 원문과 서명 비밀키는 발급 직후 한 번만 표시됩니다.',
          '2. GET /ping 으로 키가 유효한지, 어느 사회복지기관에 연결됐는지 확인합니다.',
          '3. GET /charges?status=pending 로 아직 처리하지 않은 결제 건을 가져옵니다.',
          '4. 자기 서비스에 반영한 뒤 POST /charges/ack 로 결과를 알립니다. 알린 건은 다음 조회에서 빠집니다.',
          '5. 실물 상품이라면 POST /charges/shipment 로 송장을 등록합니다.',
        ],
      },
      {
        heading: '용어',
        body: [
          '후원(charge) — 후원자가 돈을 내고 사회복지기관에 반영되는 한 건. 거래번호는 MP 로 시작합니다.',
          'payerRef — 사회복지기관 전용 후원자 고정 식별자. 휴대폰 번호를 직접 주고받지 않기 위해 씁니다.',
          'MO — 후원자가 보낸 문자(수신). MT — 기브싸인가 보내는 문자(발신).',
        ],
      },
    ],
  },

  // =========================================================== 02 인증·키
  {
    slug: 'auth',
    order: 2,
    title: '인증·키',
    summary: 'API 키 발급, Bearer 인증, HMAC 서명, 허용 IP.',
    status: 'LIVE',
    intro: [
      '모든 요청에는 API 키가 필요합니다. 쓰기 요청에는 HMAC-SHA256 서명이 추가로 필요합니다.',
      'API 키는 후원 설정 → 연동 탭에서 발급합니다. 키 원문과 서명 비밀키는 저장하지 않으므로 발급 직후 한 번만 보여 드립니다. 분실하면 폐기 후 재발급해야 합니다.',
    ],
    sections: [
      {
        heading: '키 종류',
        body: [
          '운영 키(mp_live_) — 실제 결제·실제 문자·정산 대상입니다.',
          '테스트 키(mp_test_) — 샌드박스 전용입니다. 문자가 나가지 않고, 돈이 빠지지 않고, 정산에 잡히지 않습니다.',
          '테스트 키가 닿는 범위는 /sandbox/*, /charges 계열, /mt/* 뿐입니다. 상품·웹훅·후원자·정산·통계·수수료 API 는 운영 키로만 호출할 수 있습니다(403 LIVE_KEY_REQUIRED).',
          '모드는 발급할 때 고르며 나중에 바꿀 수 없습니다. 운영 키가 조용히 테스트로 바뀌면 어느 쪽 데이터를 건드리는지 알 수 없게 되기 때문입니다. 후원 설정 → 연동 탭에서 각각 발급하세요.',
          '접두사를 다르게 두는 이유는 운영 키를 테스트 코드에 넣는 사고를 눈으로 걸러내기 위해서입니다.',
        ],
      },
      {
        heading: '공통 헤더',
        body: ['모든 요청에 Authorization 헤더를 넣습니다. 쓰기 요청(POST 등)에는 타임스탬프와 서명 헤더를 더합니다.'],
        code: {
          label: '헤더',
          text: [
            'Authorization: Bearer {API 키}',
            'Content-Type: application/json',
            '',
            'x-givesign-timestamp: {유닉스 초}',
            'x-givesign-signature: {아래 서명값}',
          ].join('\n'),
        },
      },
      {
        heading: 'HMAC-SHA256 서명',
        body: [
          '서명 대상 문자열은 타임스탬프, HTTP 메서드(대문자), 요청 경로, 본문 원문을 마침표로 이어 붙인 값입니다. 서명 비밀키로 HMAC-SHA256 을 계산해 16진수 소문자로 보냅니다.',
          '본문은 JSON.parse 하기 전의 원문 그대로여야 합니다. 다시 직렬화하면 공백·키 순서가 달라져 서명이 어긋납니다.',
          '타임스탬프는 초 단위이며 서버 시각과 300초 넘게 벌어지면 거절됩니다. 밀리초로 보내면 오차 검사에서 걸립니다. 서버 시계를 NTP 로 맞춰 주세요.',
          '같은 서명을 다시 보내면 재전송으로 보고 거절합니다(쓰기 요청만).',
        ],
        code: {
          label: 'Node.js',
          text: [
            "const crypto = require('crypto');",
            '',
            'const ts = Math.floor(Date.now() / 1000).toString();',
            'const body = JSON.stringify(payload);',
            "const base = `${ts}.POST./api/partner/v1/charges/ack.${body}`;",
            "const signature = crypto.createHmac('sha256', signingSecret).update(base).digest('hex');",
          ].join('\n'),
        },
      },
      {
        heading: '허용 IP',
        body: [
          '키를 발급할 때 호출을 허용할 IP 를 지정할 수 있습니다. 비워 두면 어디서나 호출할 수 있습니다.',
          '운영 키에는 IP 를 지정하시길 권합니다. 키가 유출돼도 다른 곳에서는 쓸 수 없습니다.',
        ],
      },
    ],
    endpoints: [
      {
        method: 'GET',
        path: '/ping',
        summary: '연결 점검',
        status: 'LIVE',
        signed: false,
        description: '키가 유효한지, 어느 사회복지기관에 연결됐는지 확인합니다. 서명 없이 Bearer 만으로 호출할 수 있어 연동 첫 단계에 씁니다.',
        responseExample:
          '{\n  "ok": true,\n  "merchantCode": "GIV-8K2M",\n  "merchantName": "바람소리",\n  "mode": "LIVE",\n  "sandbox": false,\n  "serverTime": "2026-09-05T12:34:56.000Z"\n}',
        notes: ['mode 로 지금 붙은 키가 운영인지 테스트인지 확인할 수 있습니다. 배포 직후 가장 먼저 확인할 값입니다.'],
      },
      {
        method: 'GET',
        path: '/me',
        summary: '사회복지기관 정보 조회',
        status: 'PLANNED',
        signed: false,
        description: '사회복지기관 프로필, 결제 모드, 배정된 수신번호, 결제 한도를 한 번에 조회합니다.',
      },
      {
        method: 'GET',
        path: '/keys',
        summary: '발급된 키 목록',
        status: 'PLANNED',
        signed: false,
        description: '키 원문은 포함하지 않습니다. 접두사·이름·마지막 사용 시각·폐기 여부만 돌려줍니다.',
      },
      {
        method: 'POST',
        path: '/keys/rotate',
        summary: '키 무중단 교체',
        status: 'PLANNED',
        signed: true,
        description: '새 키를 발급하고 기존 키에 유예 기간을 둡니다. 배포 중에 인증이 끊기지 않게 합니다.',
        notes: ['유예 기간 동안은 두 키가 모두 동작합니다. 유예가 끝나면 구키는 자동 폐기됩니다.'],
      },
      {
        method: 'DELETE',
        path: '/keys/{prefix}',
        summary: '키 폐기',
        status: 'PLANNED',
        signed: true,
        params: [{ name: 'prefix', in: 'path', type: 'string', required: true, description: '폐기할 키의 접두사' }],
      },
    ],
  },

  // =========================================================== 03 샌드박스
  {
    slug: 'sandbox',
    order: 3,
    title: '샌드박스(테스트)',
    summary: '테스트 키로 실제 영향 없이 전체 흐름을 시험합니다.',
    status: 'LIVE',
    intro: [
      '테스트 키로 하는 모든 호출은 실제 세계에 아무 영향이 없습니다. 문자가 나가지 않고, 돈이 빠지지 않고, 정산에 잡히지 않습니다.',
      '샌드박스가 없으면 운영 키로 시험하게 됩니다. 그러면 실제 문자가 나가고 실제 결제가 잡힙니다. 그래서 테스트 키를 따로 둡니다.',
    ],
    sections: [
      {
        heading: '테스트 데이터는 어디에 쌓이나',
        body: [
          '테스트 데이터는 실제 결제 테이블과 물리적으로 분리된 별도 저장소에 들어갑니다. 운영 데이터에 플래그를 달아 섞는 방식이 아닙니다.',
          '집계 한 곳만 빠뜨려도 테스트 금액이 실제 정산에 섞이는데, 그런 사고는 정산일이 되어서야 드러납니다. 애초에 같은 테이블에 넣지 않으면 그럴 일이 없습니다.',
          '사회복지기관당 최근 500건까지 보관하며, 넘으면 오래된 것부터 지워집니다. 언제든 초기화할 수 있습니다.',
        ],
      },
      {
        heading: '테스트 키로 무엇이 달라지나',
        body: [
          '테스트 키로 `/charges`, `/charges/ack`, `/charges/shipment`, `/mt/*` 를 호출하면 샌드박스 데이터를 대상으로 동작합니다. 경로도 응답 모양도 운영과 같습니다.',
          '그래서 결제 연동과 문자 발송을 테스트 키로 완성한 뒤, 키만 운영 키로 바꾸면 그대로 동작합니다. 코드를 고칠 필요가 없습니다.',
          '아래 `/sandbox/*` 엔드후원금는 테스트 키로만 호출할 수 있습니다. 운영 키로 부르면 403 TEST_KEY_REQUIRED 가 납니다.',
          '반대로 위에 적힌 것 밖의 API — 상품(/products), 웹훅(/webhooks), 후원자(/payers), 정산(/settlements), 통계(/stats), 수수료(/fees) — 는 테스트 키로 호출할 수 없습니다. 403 LIVE_KEY_REQUIRED 가 납니다.',
          '샌드박스 사본이 없는 영역이라, 테스트 키를 허용하면 시험 삼아 돌린 스크립트가 운영 상품을 지우고 운영 웹훅을 갈아 끼우게 됩니다. 이 API 들은 운영 키로만 부르고, 지워도 되는 값으로 시험해 주세요.',
        ],
      },
      {
        heading: '권장 시험 순서',
        body: [
          '1. 테스트 키를 발급합니다(후원 설정 → 연동 탭에서 모드를 "테스트"로).',
          '2. `GET /ping` 으로 mode 가 TEST 인지 확인합니다.',
          '3. `POST /sandbox/mo` 로 후원자가 문자를 보낸 상황을 만듭니다. 아직 결제 전 상태입니다.',
          '4. `POST /sandbox/charges/{transactionNo}/succeed` 로 결제를 성공으로 확정합니다.',
          '5. `GET /charges?status=pending` 으로 그 건이 내려오는지 확인합니다.',
          '6. `POST /charges/ack` 로 지급 처리했다고 알린 뒤, 다시 조회해 빠졌는지 확인합니다.',
          '7. `GET /sandbox/outbox` 로 그동안 나갔을 문자 전문을 확인합니다.',
          '8. 실패 분기도 시험하려면 3번을 다시 하고 `/fail` 로 확정해 봅니다.',
        ],
      },
    ],
    endpoints: [
      {
        method: 'POST',
        path: '/sandbox/mo',
        summary: '모의 MO 주입',
        status: 'LIVE',
        signed: true,
        sandboxOnly: true,
        description:
          '후원자가 수신번호로 문자를 보낸 것처럼 만듭니다. 통신망을 거치지 않으며, 만들어진 건은 아직 결제 전(PENDING_PAYMENT)입니다.',
        params: [
          { name: 'from', in: 'body', type: 'string', required: true, description: '보낸 사람 휴대폰 번호', example: '01012345678' },
          { name: 'text', in: 'body', type: 'string', required: true, description: '문자 본문' },
          { name: 'amount', in: 'body', type: 'number', description: '결제 금액(원). 생략하면 10000', example: '10000' },
          { name: 'productName', in: 'body', type: 'string', description: '상품 이름(선택)' },
          { name: 'productKind', in: 'body', type: 'string', description: 'DIGITAL | PHYSICAL (선택)' },
        ],
        notes: ['실제 흐름과 같게, 이 시점에 "아직 결제되지 않았습니다" 안내 문자가 나간 것으로 문자함에 기록됩니다.'],
      },
      {
        method: 'POST',
        path: '/sandbox/charges/{transactionNo}/succeed',
        summary: '모의 결제 성공',
        status: 'LIVE',
        signed: true,
        sandboxOnly: true,
        description: '결제사 승인이 난 것처럼 성공으로 확정합니다. 결제사를 호출하지 않고 돈도 움직이지 않습니다.',
        notes: ['이미 확정된 건은 다시 바뀌지 않습니다. 여러 번 불러도 결과가 같습니다.'],
      },
      {
        method: 'POST',
        path: '/sandbox/charges/{transactionNo}/fail',
        summary: '모의 결제 실패',
        status: 'LIVE',
        signed: true,
        sandboxOnly: true,
        description: '사유를 지정해 실패로 확정합니다. 실패 분기 처리를 시험할 때 씁니다.',
        params: [{ name: 'reason', in: 'body', type: 'string', description: '실패 사유. 생략하면 "테스트 실패"' }],
      },
      {
        method: 'GET',
        path: '/sandbox/outbox',
        summary: '모의 발송함',
        status: 'LIVE',
        signed: false,
        sandboxOnly: true,
        description: '테스트 중 나갔을 문자와 받은 것으로 친 문자를 최신순으로 돌려줍니다. 실제로는 발송되지 않았습니다.',
        params: [{ name: 'limit', in: 'query', type: 'number', description: '1~200 (기본 50)' }],
      },
      {
        method: 'POST',
        path: '/sandbox/reset',
        summary: '테스트 데이터 초기화',
        status: 'LIVE',
        signed: true,
        sandboxOnly: true,
        notes: ['운영 데이터는 지워지지 않습니다. 이 사회복지기관의 테스트 데이터만 지웁니다.'],
      },
      {
        method: 'POST',
        path: '/sandbox/webhooks/fire',
        summary: '웹훅 임의 발사',
        status: 'LIVE',
        signed: true,
        sandboxOnly: true,
        description: '원하는 이벤트를 골라 등록된 수신 URL 로 보냅니다. 실제 거래 없이 수신 처리와 서명 검증을 시험할 수 있습니다.',
        params: [
          { name: 'type', in: 'body', type: 'string', required: true, description: '보낼 이벤트 종류' },
          { name: 'data', in: 'body', type: 'object', description: '본문 data 에 합쳐 넣을 값' },
        ],
      },
    ],
  },

  // =========================================================== 04 결제·후원
  {
    slug: 'charges',
    order: 4,
    title: '결제·후원',
    summary: '결제 완료 건을 가져가 처리하고 결과를 알립니다.',
    status: 'LIVE',
    intro: [
      '가장 먼저 붙이는 연동입니다. 결제가 완료된 건을 오래된 순으로 가져가 자기 서비스에 반영한 뒤, 처리했다고 알려주면 다음 조회에서 빠집니다.',
      '후원자 식별은 마스킹된 휴대폰 번호 또는 사회복지기관 전용 고정 식별자(payerRef)로 합니다. 후원자 원문 번호는 내려가지 않습니다(실물 주문의 배송지 연락처는 배송에 필요해 예외입니다).',
    ],
    sections: [
      {
        heading: '금액과 후원금',
        body: ['금액은 원 단위 정수입니다. 소수점이 없습니다. 후원금 환산은 사회복지기관이 정합니다(기본 안내는 1원 = 1후원금).'],
      },
      {
        heading: '중복 처리 방지',
        body: [
          'ack 는 멱등입니다. 같은 거래번호를 여러 번 보내도 결과가 같습니다.',
          '이미 SENT 인 건은 다시 바뀌지 않습니다. 되돌려야 하면 기브싸인 관리자에게 문의해 주세요.',
        ],
      },
    ],
    endpoints: [
      {
        method: 'GET',
        path: '/charges',
        summary: '결제 완료 건 조회',
        status: 'LIVE',
        signed: false,
        description: '결제가 완료된 후원 건을 오래된 순으로 내려줍니다. 처리하지 않은 건만 받으려면 status=pending 을 씁니다.',
        params: [
          { name: 'status', in: 'query', type: 'string', description: 'pending(기본) | all', example: 'pending' },
          { name: 'since', in: 'query', type: 'ISO8601', description: '이 시각 이후 결제 건만' },
          { name: 'limit', in: 'query', type: 'number', description: '1~500 (기본 100)', example: '100' },
          { name: 'cursor', in: 'query', type: 'string', description: '직전 응답의 nextCursor' },
        ],
        responseExample:
          '{\n  "ok": true,\n  "items": [\n    {\n      "transactionNo": "MP...",\n      "amount": 10000,\n      "message": "응원합니다",\n      "payerRef": "...",\n      "payerPhoneMasked": "010--5678",\n      "paidAt": "2026-09-05T03:34:56.000Z",\n      "product": { "name": "후원금 10,000", "kind": "DIGITAL" }\n    }\n  ],\n  "nextCursor": null\n}',
      },
      {
        method: 'POST',
        path: '/charges/ack',
        summary: '처리 결과 통보',
        status: 'LIVE',
        signed: true,
        description: '후원금 적립을 끝냈다고(또는 보류했다고) 알립니다. 알린 건은 다음 pending 조회에서 빠집니다.',
        params: [
          { name: 'transactionNos', in: 'body', type: 'string[]', required: true, description: '처리한 거래번호 목록' },
          { name: 'status', in: 'body', type: 'string', required: true, description: 'SENT | FAILED' },
          { name: 'note', in: 'body', type: 'string', description: '보류·실패 사유' },
        ],
        notes: ['멱등입니다. 같은 건을 여러 번 보내도 결과가 같습니다.'],
      },
      {
        method: 'GET',
        path: '/charges/{transactionNo}',
        summary: '결제 건 단건 조회',
        status: 'PLANNED',
        signed: false,
        description: '거래번호 하나의 상세를 조회합니다. 목록을 다시 훑지 않고 특정 건만 확인할 때 씁니다.',
      },
      {
        method: 'POST',
        path: '/charges/refund',
        summary: '환불 요청',
        status: 'PLANNED',
        signed: true,
        description: '사회복지기관이 환불을 요청합니다. 승인과 실제 환불 처리는 기브싸인가 합니다.',
      },
      {
        method: 'GET',
        path: '/charges/export',
        summary: '기간 내역 CSV',
        status: 'PLANNED',
        signed: false,
        description: '기간을 지정해 후원 내역을 CSV 로 내려받습니다.',
      },
      {
        method: 'POST',
        path: '/charges/link',
        summary: '결제 링크 발급',
        status: 'PLANNED',
        signed: true,
        description: '사회복지기관이 자기 사이트에서 결제 링크를 직접 만들어 후원자에게 보여 줍니다. 문자를 거치지 않는 웹 결제 경로입니다.',
      },
    ],
  },

  // =========================================================== 05 상품·재고
  {
    slug: 'products',
    order: 5,
    title: '상품·재고',
    summary: '사회복지기관 사이트의 상품을 기브싸인와 맞춥니다.',
    status: 'LIVE',
    intro: [
      '지금까지는 사회복지기관 사이트에 있는 상품을 기브싸인 콘솔에 한 번 더 손으로 등록해야 했습니다. 파는 물건이 바뀔 때마다 두 곳을 맞춰야 하니 반드시 어긋납니다. 이 연동이 그 이중 등록을 없앱니다.',
      '실물 상품과 비실물 상품(후원금·상품권·이용권·컨텐츠)을 모두 다룹니다.',
    ],
    sections: [
      {
        heading: '상품은 지우지 않습니다',
        body: [
          '지난 결제가 상품을 참조하므로 삭제하면 주문 내역이 깨집니다. 그래서 DELETE 는 실제 삭제가 아니라 판매 중지(보관 처리)입니다.',
          '보관 처리된 상품은 문자 안내와 결제 화면에서 빠지고, 지난 주문에서는 그대로 보입니다.',
        ],
      },
      {
        heading: '일괄 동기화는 sku 를 열쇠로 씁니다',
        body: [
          '`/products/bulk` 는 sku 로 기존 상품과 맞춥니다. 있으면 내용을 갱신하고 없으면 새로 만듭니다.',
          'archiveMissing 을 true 로 주면 보낸 목록에 없는 상품을 판매 중지합니다. 사회복지기관 사이트에서 내린 상품이 기브싸인에서는 계속 팔리는 것을 막기 위한 것입니다.',
          '보관 처리됐던 상품이 목록에 다시 오면 판매 상태로 되살아납니다.',
        ],
      },
      {
        heading: '재고',
        body: [
          '재고 차감은 결제 승인 시점에 상품 단위 잠금 안에서 이뤄집니다. `/stock` 은 값을 덮어쓰기만 하므로 동시 결제와 경쟁하지 않습니다.',
          'stock 이 null 이면 재고를 세지 않습니다(무제한). 0 이면 문자 안내에서 그 상품이 빠지고 결제도 막힙니다.',
          'stockAlert 이하로 떨어지면 `product.stock_low` 웹훅이 나갑니다.',
        ],
      },
    ],
    endpoints: [
      {
        method: 'GET',
        path: '/products',
        summary: '상품 목록',
        status: 'LIVE',
        signed: false,
        params: [{ name: 'includeArchived', in: 'query', type: 'boolean', description: 'true 면 보관 처리된 상품도 포함' }],
      },
      {
        method: 'POST',
        path: '/products',
        summary: '상품 등록',
        status: 'LIVE',
        signed: true,
        params: [
          { name: 'name', in: 'body', type: 'string', required: true, description: '상품 이름' },
          { name: 'amount', in: 'body', type: 'number', required: true, description: '결제 금액(원, 정수)' },
          { name: 'kind', in: 'body', type: 'string', description: 'DIGITAL(기본) | PHYSICAL' },
          { name: 'digitalType', in: 'body', type: 'string', description: 'POINT | VOUCHER | PASS | CONTENT' },
          { name: 'sku', in: 'body', type: 'string', description: '사회복지기관 상품 코드. 일괄 동기화의 열쇠' },
          { name: 'stock', in: 'body', type: 'number', description: '재고. null 이면 무제한' },
          { name: 'fulfillment', in: 'body', type: 'string', description: 'MANUAL | API | INSTANT' },
        ],
      },
      { method: 'PATCH', path: '/products/{id}', summary: '상품 수정', status: 'LIVE', signed: true, description: '보낸 항목만 바꿉니다. 보내지 않은 항목은 그대로 둡니다.' },
      { method: 'DELETE', path: '/products/{id}', summary: '판매 중지(보관 처리)', status: 'LIVE', signed: true, notes: ['실제로 삭제하지 않습니다. 지난 주문에서는 그대로 보입니다.'] },
      {
        method: 'PATCH',
        path: '/products/{id}/stock',
        summary: '재고·품절 갱신',
        status: 'LIVE',
        signed: true,
        params: [
          { name: 'stock', in: 'body', type: 'number', required: true, description: '남은 수량. null 이면 재고를 세지 않음' },
          { name: 'stockAlert', in: 'body', type: 'number', description: '이 값 이하면 product.stock_low 웹훅 발송' },
        ],
      },
      {
        method: 'POST',
        path: '/products/bulk',
        summary: '일괄 등록·동기화',
        status: 'LIVE',
        signed: true,
        params: [
          { name: 'items', in: 'body', type: 'object[]', required: true, description: '상품 목록. 모든 항목에 sku 가 필요합니다 (최대 200건)' },
          { name: 'archiveMissing', in: 'body', type: 'boolean', description: 'true 면 목록에 없는 상품을 판매 중지' },
        ],
      },
      { method: 'GET', path: '/products/{id}/options', summary: '옵션·옵션가 조회', status: 'LIVE', signed: false },
    ],
  },

  // =========================================================== 06 주문·배송
  {
    slug: 'orders',
    order: 6,
    title: '주문·배송',
    summary: '실물 주문의 송장 등록과 반품·교환 처리.',
    status: 'LIVE',
    intro: [
      '실물 상품을 파는 사회복지기관만 필요한 연동입니다. 자기 물류 시스템에서 출고한 결과를 기브싸인에 올려 후원자가 조회할 수 있게 합니다.',
      '송장 없이 발송 처리하면 후원자가 배송을 조회할 수 없고, 분쟁이 났을 때 발송 사실을 증명하지 못합니다. 그래서 SHIPPED 로 바꾸려면 택배사와 송장번호가 반드시 있어야 합니다.',
    ],
    endpoints: [
      {
        method: 'POST',
        path: '/charges/shipment',
        summary: '배송 상태·송장 등록',
        status: 'LIVE',
        signed: true,
        params: [
          { name: 'transactionNo', in: 'body', type: 'string', required: true, description: '거래번호' },
          { name: 'status', in: 'body', type: 'string', required: true, description: 'PREPARING | SHIPPED | DELIVERED 등' },
          { name: 'carrier', in: 'body', type: 'string', description: '택배사 (SHIPPED 시 필수)' },
          { name: 'trackingNo', in: 'body', type: 'string', description: '송장번호 (SHIPPED 시 필수)' },
        ],
        notes: [
          '멱등입니다. 같은 값을 다시 보내도 결과가 같습니다.',
          '이 API 로 바꿀 때는 안내 문자가 나가지 않습니다. 발송 안내 문자는 사회복지기관 콘솔(후원 처리)에서 발송 처리할 때만 나갑니다. API 로 처리한 뒤 문자를 보내려면 문자 발송 API 를 함께 호출해 주세요.',
        ],
      },
      { method: 'GET', path: '/orders', summary: '주문 목록', status: 'PLANNED', signed: false },
      { method: 'GET', path: '/orders/{orderNo}', summary: '주문 상세', status: 'PLANNED', signed: false, notes: ['배송지 원문 열람은 감사 로그에 남습니다.'] },
      { method: 'POST', path: '/orders/{orderNo}/return', summary: '반품 접수·상태 갱신', status: 'PLANNED', signed: true },
      { method: 'POST', path: '/orders/{orderNo}/exchange', summary: '교환 접수·재발송', status: 'PLANNED', signed: true },
      { method: 'GET', path: '/carriers', summary: '택배사 코드표', status: 'PLANNED', signed: false },
    ],
  },

  // =========================================================== 07 후원자 연결
  {
    slug: 'payers',
    order: 7,
    title: '후원자 연결',
    summary: '사회복지기관 회원과 기브싸인 후원자를 잇습니다.',
    status: 'LIVE',
    intro: [
      '사회복지기관 회원과 기브싸인 후원자를 잇는 연동입니다. 휴대폰 번호를 그대로 주고받지 않고 payerRef 라는 고정 식별자로 다룹니다.',
      '같은 사람이라도 사회복지기관마다 payerRef 가 다릅니다. 사회복지기관끼리 값을 맞춰 봐도 같은 사람인지 알 수 없게 만든 설계입니다.',
    ],
    sections: [
      {
        heading: '회원 연결을 왜 하나',
        body: [
          '연결해 두면 결제 건이 어느 회원의 것인지 매번 대조하지 않아도 됩니다. 사회복지기관 회원 상세 화면에 결제 이력을 그대로 붙일 수 있습니다.',
          '연결을 끊어도 결제 이력과 후원자는 그대로 남습니다. 지난 거래는 지워질 수 없는 기록입니다.',
        ],
      },
      {
        heading: 'payerRef 는 어디서 얻나',
        body: [
          '결제 건 조회(`GET /charges`) 응답의 payerRef 필드에 들어 있습니다. 이 값을 사회복지기관 회원 정보에 저장해 두고 쓰면 됩니다.',
        ],
      },
    ],
    endpoints: [
      { method: 'GET', path: '/payers/{payerRef}', summary: '후원자 요약', status: 'LIVE', signed: false, description: '마스킹 번호, 누적 결제 금액·횟수, 최근 결제일, 차단 여부.' },
      {
        method: 'POST',
        path: '/payers/link',
        summary: '회원 매핑 등록',
        status: 'LIVE',
        signed: true,
        params: [
          { name: 'payerRef', in: 'body', type: 'string', required: true, description: '결제 건 조회 응답의 payerRef' },
          { name: 'merchantMemberId', in: 'body', type: 'string', required: true, description: '사회복지기관 사이트의 회원 ID (100자 이내)' },
        ],
      },
      { method: 'GET', path: '/payers/{payerRef}/charges', summary: '후원자별 결제 이력', status: 'LIVE', signed: false },
      { method: 'DELETE', path: '/payers/link/{payerRef}', summary: '회원 연결 해제', status: 'LIVE', signed: true, notes: ['연결만 끊습니다. 결제 이력은 남습니다.'] },
    ],
  },

  // =========================================================== 08 MO 수신
  {
    slug: 'mo',
    order: 8,
    title: 'MO 수신',
    summary: '후원자가 보낸 문자를 사회복지기관 사이트로 가져갑니다.',
    status: 'PLANNED',
    intro: [
      '후원자가 사회복지기관 수신번호로 보낸 문자를 사회복지기관 서버가 받아 볼 수 있게 하는 연동입니다.',
      '두 가지 방식을 함께 제공합니다. 수신 서버가 있으면 웹훅(실시간)을, 없으면 조회(주기적으로 가져가기)를 쓰시면 됩니다.',
    ],
    sections: [
      {
        heading: '수신번호 체계',
        body: [
          '사회복지기관마다 고유한 수신번호가 배정됩니다. 후원자가 그 번호로 문자를 보내면 어느 사회복지기관인지 번호만으로 구분됩니다.',
          '대표번호를 여러 사회복지기관이 함께 쓰는 경우에는 문자 맨 앞의 키워드로 구분합니다.',
        ],
      },
    ],
    endpoints: [
      { method: 'GET', path: '/mo/messages', summary: '수신 문자 조회', status: 'PLANNED', signed: false, description: '커서 페이징으로 수신 문자를 가져갑니다. 수신 서버가 없을 때 쓰는 방식입니다.' },
      { method: 'GET', path: '/mo/messages/{id}', summary: '수신 문자 단건', status: 'PLANNED', signed: false },
      { method: 'GET', path: '/mo/numbers', summary: '내 수신번호 조회', status: 'PLANNED', signed: false, description: '배정된 수신번호와 상태, 키워드를 확인합니다.' },
      { method: 'POST', path: '/mo/keywords', summary: '키워드 라우팅 등록', status: 'PLANNED', signed: true },
    ],
  },

  // =========================================================== 09 MT 발송
  {
    slug: 'mt',
    order: 9,
    title: 'MT 발송',
    summary: '사회복지기관이 후원자에게 거래 안내 문자를 보냅니다.',
    status: 'LIVE',
    intro: [
      '사회복지기관이 자기 후원자에게 문자를 보내는 연동입니다. 지금 열려 있는 v1 은 범위를 좁게 잡았습니다.',
      '범위를 좁힌 이유는 규제 때문입니다. 아래 네 가지 제약이 있으면 광고성 정보에 붙는 사전 동의, 야간 발송 제한, 수신거부 문구 의무가 적용 대상이 아니게 됩니다. 그래서 사회복지기관이 준비할 것이 거의 없습니다.',
    ],
    sections: [
      {
        heading: 'v1 의 네 가지 제약',
        body: [
          '1. 발신번호는 기브싸인 번호로 고정됩니다. 사회복지기관이 발신번호를 따로 등록하지 않아도 됩니다.',
          '2. 정보성 문자만 보낼 수 있습니다. 거래·주문·지급과 직접 관련된 안내여야 하며 광고·홍보 문구는 보낼 수 없습니다.',
          '3. 수신자는 그 사회복지기관에 거래 이력이 있는 후원자만 지정할 수 있습니다. payerRef 또는 transactionNo 로만 지정하며 임의의 번호를 넣을 수 없습니다.',
          '4. 미리 등록해 검수받은 템플릿과 치환자만 쓸 수 있습니다. 자유 본문은 보낼 수 없습니다.',
        ],
      },
      {
        heading: '템플릿 검수는 언제 하나',
        body: [
          '검수는 템플릿을 등록할 때 한 번만 합니다. 통과한 템플릿은 발송할 때 다시 검사하지 않습니다.',
          '자동 검사(링크·개인정보·금칙어·광고 표현)를 통과하면 바로 승인되어 곧바로 쓸 수 있습니다. 광고성 표현이 보이면 검수 대기로 저장되고 사람이 확인합니다.',
          '후원 설정 → 안내 문자 탭에서 화면으로 등록할 수도 있고, 아래 API 로 등록할 수도 있습니다. 두 곳이 같은 템플릿을 봅니다.',
        ],
      },
      {
        heading: '치환자',
        body: [
          '본문에 {이름} 형태로 넣습니다. {사회복지기관} 은 시스템이 자동으로 채우므로 값을 넘기지 않아도 됩니다.',
          '그 밖의 치환자는 발송할 때 variables 로 값을 모두 넘겨야 합니다. 하나라도 빠지면 발송이 거절됩니다 — 후원자에게 {상품} 이 그대로 나가는 것을 막기 위해서입니다.',
          '예: "{사회복지기관} 주문하신 {상품} 출고가 {일수}일 늦어집니다." → variables 로 상품과 일수를 넘깁니다.',
          '치환값도 검사합니다. 값 하나는 40자 이내여야 하고, 링크·줄바꿈·중괄호·광고 표현·금칙어·개인정보(전화번호·계좌·이메일)가 들어가면 발송이 거절됩니다(INVALID_VARIABLES).',
          '본문 검수를 통과한 템플릿이라도 빈칸에 광고 문구를 넣으면 광고 문자가 되기 때문입니다. 치환값에는 상품명·주문번호·날짜처럼 그 거래를 가리키는 짧은 값만 넣어 주세요.',
        ],
      },
      {
        heading: '멱등키가 필수인 이유',
        body: [
          '발송 요청에는 Idempotency-Key 헤더가 반드시 필요합니다. 같은 키로 다시 보내면 새로 발송하지 않고 처음 결과를 그대로 돌려줍니다.',
          '네트워크가 끊겨 재시도했을 때 같은 문자가 두 번 나가면 후원자는 그것을 스팸으로 받아들입니다. 되돌릴 수 없는 작업이라 키를 필수로 두었습니다.',
        ],
      },
      {
        heading: '테스트로 먼저 해 보기',
        body: [
          '테스트 키로 발송하면 실제로는 나가지 않고 테스트 문자함에만 쌓입니다. 템플릿 검사와 치환 규칙은 운영과 똑같이 적용됩니다.',
          '테스트 키 발송은 하루 한도를 쓰지 않습니다. 먼저 /sandbox/mo 로 거래를 만들고, 그 거래번호나 payerRef 로 보내 보세요.',
        ],
      },
      {
        heading: 'v2 로 미루는 것',
        body: [
          '사회복지기관 발신번호 등록, 자유 본문, 광고성 발송, 대량 캠페인, 예약 발송, 카카오 알림톡 대체발송은 별도 계약과 심사가 필요합니다. 준비되는 대로 이 문서에 추가됩니다.',
        ],
      },
    ],
    endpoints: [
      {
        method: 'POST',
        path: '/mt/messages',
        summary: '문자 1건 발송',
        status: 'LIVE',
        signed: true,
        description: '등록해 승인받은 템플릿과 치환값으로 문자를 보냅니다.',
        params: [
          { name: 'Idempotency-Key', in: 'header', type: 'string', required: true, description: '중복 발송 방지. 100자 이내' },
          { name: 'templateCode', in: 'body', type: 'string', required: true, description: '승인된 템플릿 코드' },
          { name: 'payerRef', in: 'body', type: 'string', description: '수신자. 거래 이력이 있는 후원자만' },
          { name: 'transactionNo', in: 'body', type: 'string', description: 'payerRef 대신 거래번호로도 지정할 수 있습니다' },
          { name: 'variables', in: 'body', type: 'object', description: '템플릿 치환값. 문자열·숫자만, 값 하나당 40자 이내' },
        ],
        notes: [
          'payerRef 와 transactionNo 중 하나는 반드시 있어야 합니다. 임의의 전화번호로는 보낼 수 없습니다.',
          '차단된 후원자에게는 보내지 않습니다(409 RECIPIENT_BLOCKED).',
          '하루 한도를 넘으면 429 QUOTA_EXCEEDED 가 납니다.',
        ],
        responseExample:
          '{\n  "ok": true,\n  "id": "...",\n  "status": "SENT",\n  "reused": false,\n  "sandbox": false,\n  "phoneMasked": "010-****-5678",\n  "quota": { "limit": 500, "used": 12, "remaining": 488 }\n}',
      },
      {
        method: 'GET',
        path: '/mt/messages/{id}',
        summary: '발송 상태 조회',
        status: 'LIVE',
        signed: false,
        description: '접수 / 발송 / 실패와 실패 사유를 돌려줍니다. 사회복지기관이 API 로 보낸 건만 조회됩니다.',
      },
      {
        method: 'GET',
        path: '/mt/messages',
        summary: '발송 이력 목록',
        status: 'LIVE',
        signed: false,
        description: '사회복지기관이 API 로 보낸 문자만 최신순으로 돌려줍니다. 시스템이 보낸 문자는 포함하지 않습니다.',
        params: [
          { name: 'limit', in: 'query', type: 'number', description: '1~200 (기본 50)' },
          { name: 'cursor', in: 'query', type: 'string', description: '직전 응답의 nextCursor' },
        ],
      },
      {
        method: 'GET',
        path: '/mt/templates',
        summary: '템플릿 목록',
        status: 'LIVE',
        signed: false,
        description: '등록된 템플릿과 상태, 발송 때 채워야 하는 치환자 목록을 돌려줍니다.',
      },
      {
        method: 'POST',
        path: '/mt/templates',
        summary: '템플릿 등록·검수 신청',
        status: 'LIVE',
        signed: true,
        params: [
          { name: 'code', in: 'body', type: 'string', required: true, description: '사회복지기관이 정하는 코드. 영문·숫자·_- 2~40자' },
          { name: 'name', in: 'body', type: 'string', description: '알아보기 위한 이름' },
          { name: 'body', in: 'body', type: 'string', required: true, description: '본문. 200자 이내, 링크 불가' },
        ],
        notes: [
          '검수는 등록 시점에 한 번만 합니다. 통과한 템플릿은 발송 때 다시 검수하지 않습니다.',
          '응답의 usable 이 false 면 아직 발송에 쓸 수 없습니다. reviewNote 에 사유가 있습니다.',
          '같은 code 로 다시 보내면 본문이 바뀌고 검수를 다시 받습니다.',
        ],
      },
      {
        method: 'GET',
        path: '/mt/quota',
        summary: '남은 발송 한도',
        status: 'LIVE',
        signed: false,
        description: '오늘 쓴 건수와 남은 건수. 대량 안내를 돌리기 전에 확인하세요.',
      },
    ],
  },

  // =========================================================== 10 웹훅
  {
    slug: 'webhooks',
    order: 10,
    title: '웹훅(이벤트 구독)',
    summary: '기브싸인에서 일어난 일을 실시간으로 받습니다.',
    status: 'LIVE',
    intro: [
      '주기적으로 가져가는 대신, 일이 생긴 순간 사회복지기관 서버로 밀어 주는 방식입니다. 수신 URL 을 등록하고 받을 이벤트를 고르면 됩니다.',
      '수신 서버를 두기 어렵다면 웹훅을 쓰지 않아도 됩니다. 결제 건 조회(`GET /charges`)만으로도 연동이 완성됩니다.',
    ],
    sections: [
      {
        heading: '이벤트 목록',
        body: [
          '지금 실제로 발생하는 이벤트 — charge.succeeded(결제 완료), charge.failed(결제 실패), mo.received(후원자가 문자를 보냄), shipment.updated(배송 상태 변경), product.stock_low(재고 부족), payer.linked(회원 연결).',
          '아직 발생하지 않는 이벤트(구독은 걸 수 있지만 오지 않습니다) — charge.refunded, mt.delivered, mt.failed, settlement.paid. 발행 지점이 준비되는 대로 이 문서에서 옮겨집니다.',
        ],
      },
      {
        heading: '서명 검증 — 반드시 하세요',
        body: [
          '모든 웹훅에는 x-givesign-signature 헤더가 붙습니다. 받는 쪽에서 반드시 검증해 주세요. 검증하지 않으면 누구나 가짜 결제 완료 이벤트를 보낼 수 있습니다.',
          '서명 원문은 타임스탬프, 이벤트 id, 본문 원문을 마침표로 이어 붙인 값입니다. 등록할 때 한 번만 보여 드리는 비밀키로 HMAC-SHA256 을 계산해 비교합니다.',
          '본문은 파싱하기 전 원문 그대로 검증해야 합니다. 다시 직렬화하면 공백·키 순서가 달라져 서명이 어긋납니다.',
        ],
        code: {
          label: 'Node.js (Express)',
          text: [
            "const crypto = require('crypto');",
            '',
            "app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {",
            "  const ts = req.get('x-givesign-timestamp');",
            "  const eventId = req.get('x-givesign-event-id');",
            "  const raw = req.body.toString('utf8');",
            "  const expected = crypto.createHmac('sha256', SECRET).update(`${ts}.${eventId}.${raw}`).digest('hex');",
            "  if (expected !== req.get('x-givesign-signature')) return res.sendStatus(401);",
            '',
            '  // 같은 eventId 가 두 번 올 수 있다. 이미 처리한 id 면 그냥 200 을 돌려준다.',
            '  res.sendStatus(200);',
            '});',
          ].join('\n'),
        },
      },
      {
        heading: '중복과 재시도',
        body: [
          '같은 이벤트가 두 번 도착할 수 있습니다. 실패하면 다시 보내기 때문입니다. 받는 쪽에서 eventId 로 걸러 주세요.',
          '2xx 가 아니면 30초 → 2분 → 10분 → 1시간 → 6시간 간격으로 다시 보냅니다. 다 쓰면 DEAD 가 되고, 전송 이력에서 수동으로 다시 보낼 수 있습니다.',
          '처리가 오래 걸리면 먼저 200 을 돌려주고 뒤에서 처리해 주세요. 응답이 10초를 넘으면 실패로 보고 재시도가 쌓입니다.',
        ],
      },
      {
        heading: '수신 URL 조건',
        body: [
          'https 여야 합니다. 평문으로 보내면 결제 정보가 중간에서 그대로 읽힙니다.',
          '내부망 주소(localhost, 10.x, 192.168.x 등)는 등록할 수 없습니다.',
        ],
      },
    ],
    endpoints: [
      {
        method: 'POST',
        path: '/webhooks',
        summary: '수신 URL 등록',
        status: 'LIVE',
        signed: true,
        params: [
          { name: 'url', in: 'body', type: 'string', required: true, description: 'https 수신 주소' },
          { name: 'events', in: 'body', type: 'string[]', description: '받을 이벤트. 비우면 전부' },
          { name: 'description', in: 'body', type: 'string', description: '메모' },
        ],
        notes: ['서명 비밀키는 이 응답에서 한 번만 돌려줍니다. 저장하지 않으므로 다시 볼 수 없습니다.'],
      },
      { method: 'GET', path: '/webhooks', summary: '등록된 수신 URL 목록', status: 'LIVE', signed: false },
      { method: 'DELETE', path: '/webhooks/{id}', summary: '등록 해제', status: 'LIVE', signed: true },
      { method: 'POST', path: '/webhooks/{id}/test', summary: '테스트 이벤트 발사', status: 'LIVE', signed: true, description: '수신 처리와 서명 검증이 되는지 확인합니다. 응답 코드를 그대로 돌려줍니다.' },
      { method: 'GET', path: '/webhooks/deliveries', summary: '전송 이력·실패 사유', status: 'LIVE', signed: false, params: [{ name: 'status', in: 'query', type: 'string', description: 'PENDING | SENT | DEAD' }] },
      { method: 'POST', path: '/webhooks/deliveries/{id}/retry', summary: '실패 건 재전송', status: 'LIVE', signed: true, notes: ['재시도 한도를 다 쓴 건(DEAD)도 여기서 되살릴 수 있습니다.'] },
    ],
  },

  // =========================================================== 11 정산·수수료
  {
    slug: 'settlements',
    order: 11,
    title: '정산·수수료',
    summary: '정산 회차와 명세, 적용 수수료율.',
    status: 'LIVE',
    intro: [
      '사회복지기관 회계 시스템에 정산 내역을 자동으로 넣기 위한 연동입니다.',
      '정산 기준과 지급 일정은 콘솔의 정산 관리 화면과 같습니다. 이 API 는 같은 값을 기계가 읽을 수 있게 내려줍니다.',
    ],
    sections: [
      {
        heading: '금액이 어떻게 갈리나',
        body: [
          'amount 는 정산 대상 금액, withholding 은 원천징수 합계(소득세 + 지방소득세), payoutAmount 는 실제로 입금되는 금액입니다.',
          '건별 내역은 회차 상세의 entries 에 있습니다. 결제·환불·수수료가 부호 있는 금액으로 들어갑니다(수취 증가는 +, 차감은 -).',
        ],
      },
      {
        heading: '수수료율',
        body: [
          '`/fees` 는 지금 적용되는 수수료율과 정산 주기를 돌려줍니다. 판매가를 정할 때 쓰는 값입니다.',
          '사회복지기관 전용 정책이 있으면 그 값이, 없으면 전역 정책이 내려갑니다. 정책 행 자체가 없으면 configured 가 false 로 나옵니다.',
        ],
      },
    ],
    endpoints: [
      { method: 'GET', path: '/settlements', summary: '정산 회차 목록', status: 'LIVE', signed: false, params: [{ name: 'limit', in: 'query', type: 'number', description: '1~100 (기본 50)' }] },
      { method: 'GET', path: '/settlements/{id}', summary: '회차 상세', status: 'LIVE', signed: false, description: '건별 원장 항목까지 내려줍니다.' },
      { method: 'GET', path: '/settlements/{id}/export', summary: '정산 명세 CSV', status: 'LIVE', signed: false, notes: ['엑셀에서 바로 열리도록 UTF-8 BOM 을 붙여 내려줍니다.'] },
      { method: 'GET', path: '/fees', summary: '적용 수수료율', status: 'LIVE', signed: false },
    ],
  },

  // =========================================================== 12 리포트·통계
  {
    slug: 'stats',
    order: 12,
    title: '리포트·통계',
    summary: '일별·상품별·문자 집계.',
    status: 'LIVE',
    intro: [
      '사회복지기관 자체 대시보드에 기브싸인 지표를 함께 띄우기 위한 연동입니다.',
      '집계된 값만 내려가므로 개인정보가 포함되지 않습니다. 날짜 묶음(date)은 KST 자정 기준입니다.',
    ],
    endpoints: [
      {
        method: 'GET',
        path: '/stats/daily',
        summary: '일별 집계',
        status: 'LIVE',
        signed: false,
        description: '날짜별 결제 건수·금액, 실패 건수, 환불 건수.',
        params: [{ name: 'days', in: 'query', type: 'number', description: '1~92 (기본 30)' }],
      },
      {
        method: 'GET',
        path: '/stats/products',
        summary: '상품별 집계',
        status: 'LIVE',
        signed: false,
        description: '상품별 판매 건수·수량·금액. 금액이 큰 순서로 내려갑니다.',
        params: [{ name: 'days', in: 'query', type: 'number', description: '1~366 (기본 30)' }],
      },
      {
        method: 'GET',
        path: '/stats/messages',
        summary: '문자 집계',
        status: 'LIVE',
        signed: false,
        description: 'MO 수신, MT 발송, 그중 사회복지기관이 API 로 보낸 건수와 실패 건수.',
        params: [{ name: 'days', in: 'query', type: 'number', description: '1~92 (기본 30)' }],
      },
    ],
  },

  // =========================================================== 13 로드맵
  {
    slug: 'roadmap',
    order: 13,
    title: '로드맵',
    summary: '앞으로 열릴 연동 영역. 전부 준비 중입니다.',
    status: 'PLANNED',
    intro: [
      '구상 단계인 영역까지 미리 공개합니다. 사회복지기관이 중장기 계획을 세울 수 있게 하기 위해서입니다.',
      '아래 항목은 규격이 확정되지 않았습니다. 순서와 내용이 바뀔 수 있습니다.',
    ],
    sections: [
      {
        heading: '문서·전자계약',
        body: ['계약서나 문서를 후원자에게 문자로 전달하는 연동입니다. 파일을 문자에 싣지 않고 일회용 보안링크와 본인확인을 거치는 방식으로 설계 중입니다.'],
      },
      {
        heading: '파트너·리셀러',
        body: ['문서인증 서비스처럼 자기 사회복지기관을 여럿 거느린 사업자가, 기브싸인에서 받은 수신번호를 자기 사회복지기관들에게 나눠 주는 구조입니다.'],
      },
      {
        heading: '그 밖에 검토 중',
        body: [
          '정기결제·구독 — 문자로 시작하는 정기 후원',
          '카카오 알림톡 대체발송 — 문자 실패 시 폴백',
          '본인확인·인증번호 발송 API',
          '쿠폰·프로모션 코드 발급과 소진',
          '해외 번호 MO/MT',
          '사회복지기관 사이트에 넣는 결제 현황 위젯',
        ],
      },
    ],
    endpoints: [
      { method: 'POST', path: '/documents/send', summary: '문서 전달', status: 'PLANNED', signed: true, description: '계약서·문서를 후원자에게 일회용 보안링크로 보냅니다.' },
      { method: 'GET', path: '/documents/{id}', summary: '문서 열람·서명 상태', status: 'PLANNED', signed: false },
      { method: 'POST', path: '/documents/{id}/revoke', summary: '문서 링크 회수', status: 'PLANNED', signed: true },
      { method: 'POST', path: '/numbers/issue', summary: '하위 사회복지기관 번호 발급', status: 'PLANNED', signed: true },
      { method: 'DELETE', path: '/numbers/{phoneNumber}', summary: '번호 회수', status: 'PLANNED', signed: true, notes: ['회수한 번호는 냉각기간이 지나기 전에는 다시 배정되지 않습니다.'] },
      { method: 'GET', path: '/submerchants', summary: '하위 사회복지기관 목록', status: 'PLANNED', signed: false },
      { method: 'POST', path: '/submerchants', summary: '하위 사회복지기관 등록', status: 'PLANNED', signed: true },
    ],
  },

  // =========================================================== 14 공통 규약
  {
    slug: 'common',
    order: 14,
    title: '공통 규약',
    summary: '응답 형식, 오류 코드, 멱등성, 개인정보, 변경 이력.',
    status: 'LIVE',
    intro: ['모든 엔드후원금에 공통으로 적용되는 규칙입니다. 개별 문서에서 따로 설명하지 않습니다.'],
    sections: [
      {
        heading: '기본 URL',
        body: ['https://{서비스 도메인}/api/partner/v1'],
      },
      {
        heading: '응답 형식',
        body: [
          '성공과 실패 모두 같은 껍데기를 씁니다. HTTP 상태 코드만 보고 판단하지 말고 ok 값을 확인해 주세요.',
          '성공 응답의 결과는 data 로 한 번 더 감싸지 않고 최상위에 바로 놓입니다(목록은 items, 단건은 그 이름 그대로). 실패 응답의 code 와 message 도 최상위입니다.',
        ],
        code: {
          label: '응답',
          text: [
            '{',
            '  "ok": true,',
            '  "items": [ ],',
            '  "nextCursor": null',
            '}',
            '',
            '{',
            '  "ok": false,',
            '  "code": "INVALID_SIGNATURE",',
            '  "message": "서명이 올바르지 않습니다."',
            '}',
          ].join('\n'),
        },
      },
      {
        heading: '멱등성',
        body: [
          '문자 발송(POST /mt/messages)에는 Idempotency-Key 헤더가 필수입니다. 같은 키로 다시 보내면 새로 발송하지 않고 처음 결과를 그대로 돌려줍니다.',
          '다른 쓰기 요청은 아직 이 헤더를 받지 않습니다. 넣어도 무시되며, 재시도하면 다시 실행되므로 호출 전에 결과를 확인해 주세요.',
          '네트워크가 끊겨 재시도할 때 같은 작업이 두 번 일어나는 것을 막습니다. 결제·발송처럼 되돌리기 어려운 작업에서 특히 중요합니다.',
        ],
      },
      {
        heading: '페이지네이션',
        body: ['커서 방식입니다. 응답의 nextCursor 를 다음 요청의 cursor 로 넘기면 됩니다. nextCursor 가 null 이면 마지막 페이지입니다.'],
      },
      {
        heading: '시간과 금액',
        body: [
          '모든 시각은 ISO8601 문자열이며 UTC(끝에 Z)로 내려갑니다. 예: 2026-09-05T03:34:56.000Z — 한국 시간으로는 12시 34분입니다.',
          '일·월 단위로 묶어 세는 값(통계·발송 한도)의 하루 경계만 KST 자정 기준입니다.',
          '모든 금액은 원 단위 정수입니다. 소수점이 없습니다.',
        ],
      },
      {
        heading: '개인정보',
        body: [
          '후원자 휴대폰 번호는 마스킹된 형태 또는 payerRef 로만 내려갑니다. 원문 번호는 API 로 나가지 않습니다.',
          '실물 주문의 배송지(shipping)는 예외입니다. 배송에 필요하므로 수령인·연락처·주소가 원문으로 내려가며, 내려간 건은 감사 로그(SHIPMENT_ADDRESS_VIEW)에 남습니다. 배송·CS 목적으로만 쓰고 그 외 이용·제공은 금지됩니다.',
          '받은 개인정보는 목적 범위 안에서만 쓰고, 보관 기간이 지나면 파기해 주세요.',
        ],
      },
      {
        heading: '버전 정책',
        body: [
          '하위호환을 깨지 않는 변경은 v1 안에서 이뤄집니다. 필드가 늘어날 수 있으니 모르는 필드는 무시하도록 구현해 주세요.',
          '하위호환이 깨지는 변경은 v2 로 나갑니다. 기존 버전은 최소 6개월 예고 후 종료합니다.',
        ],
      },
      {
        heading: '변경 이력',
        body: [
          '2026-09-05 — 문서 허브 개설. 준비 중 API 를 미리 공개하기 시작했습니다.',
        ],
      },
    ],
  },

  // =========================================================== 15 개발자 도구
  {
    slug: 'tools',
    order: 15,
    title: '개발자 도구',
    summary: 'OpenAPI 규격 파일과 예제.',
    status: 'LIVE',
    intro: [
      '문서를 읽는 것보다 도구에 넣고 바로 호출해 보는 편이 빠릅니다.',
      'OpenAPI 규격 파일은 이 문서와 같은 원천에서 생성되므로 화면과 어긋나지 않습니다.',
    ],
    sections: [
      {
        heading: 'OpenAPI 규격 파일',
        body: [
          '`GET /api/partner/v1/openapi.json` 을 Postman·Insomnia 나 코드 생성기에 그대로 넣으면 됩니다. 인증 없이 열립니다.',
          '준비 중인 엔드후원금도 들어 있습니다. 설명 첫 줄에 [준비 중] 이 붙고 x-status 로도 구분됩니다.',
        ],
      },
      {
        heading: '아직 준비 중인 것',
        body: [
          'Postman 컬렉션 파일, 언어별 예제 코드 묶음, 콘솔 안에서 바로 호출해 보는 API 테스터.',
          '지금은 인증 문서의 서명 예제와 웹훅 문서의 검증 예제로 시작하실 수 있습니다.',
        ],
      },
    ],
    endpoints: [
      {
        method: 'GET',
        path: '/openapi.json',
        summary: 'OpenAPI 3.1 규격 파일',
        status: 'LIVE',
        signed: false,
        description: '이 문서와 같은 원천에서 생성합니다. 인증이 필요 없습니다.',
      },
    ],
  },
];

/** slug 로 카테고리를 찾는다. */
export function findCategory(slug: string): ApiCategory | undefined {
  return API_CATEGORIES.find((c) => c.slug === slug);
}

/** 목차 순서대로 정렬된 카테고리. */
export function orderedCategories(): ApiCategory[] {
  return [...API_CATEGORIES].sort((a, b) => a.order - b.order);
}

/** 레지스트리에 등록된 모든 엔드후원금(카테고리 정보 포함). */
export function allEndpoints() {
  return orderedCategories().flatMap((category) =>
    (category.endpoints ?? []).map((endpoint) => ({ category, endpoint })),
  );
}

/** 상태별 엔드후원금 개수. 허브 화면의 요약 숫자에 쓴다. */
export function endpointCounts() {
  const rows = allEndpoints();
  return {
    total: rows.length,
    live: rows.filter((r) => r.endpoint.status === 'LIVE').length,
    beta: rows.filter((r) => r.endpoint.status === 'BETA').length,
    planned: rows.filter((r) => r.endpoint.status === 'PLANNED').length,
  };
}
