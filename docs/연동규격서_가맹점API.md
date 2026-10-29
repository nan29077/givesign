# 기브싸인 사회복지기관 연동 규격서 (v1)

> **이 연동은 선택 사항입니다.**
> 사회복지기관은 기브싸인 관리자 화면(문자 관리)에서 충전 내역을 확인하고 포인트 지급 처리를
> 직접 할 수 있습니다. 이 API 는 **사회복지기관 사이트에서 포인트를 자동으로 적립**하고 싶은
> 경우에만 사용합니다.

---

## 1. 개요

### 1.1 역할 분담

| 구분 | 담당 |
| --- | --- |
| 문자 수신(MO)·문자 발송(MT) | 기브싸인 |
| 결제 승인·취소 | 기브싸인 (PG 연동) |
| 정산·지급 | 기브싸인 (지급대행) |
| 상품 등록·가격·재고·배송비 설정 | 사회복지기관 (기브싸인 관리자에서 설정) |
| **포인트·상품권·이용권 발행과 지급** | **사회복지기관** |
| **실물 상품 출고·배송** | **사회복지기관** |
| 회원 식별 | 사회복지기관 (휴대폰 번호 매칭) |

포인트는 **사회복지기관이 발행하는 자산**입니다. 기브싸인는 후원자의 결제를 대행하고 그 대금을
사회복지기관에 정산할 뿐, 포인트를 보관하거나 발행하지 않습니다.

### 1.2 연동 방식

사회복지기관 서버가 기브싸인를 **주기적으로 호출(pull)** 합니다.
기브싸인가 사회복지기관 서버를 호출하지 않으므로, 사회복지기관 쪽에 외부 수신 서버(webhook endpoint)를
따로 열지 않아도 됩니다.

```
 ①  GET  /api/partner/v1/charges?status=pending      결제 완료된 주문 조회
 ②  (사회복지기관) 휴대폰 번호로 회원을 찾아 포인트 적립 / 실물 상품 출고
 ③  POST /api/partner/v1/charges/ack                 처리 결과 통보
 ④  POST /api/partner/v1/charges/shipment            (실물) 송장 등록
```

권장 주기: **1~5분**. 분당 요청 한도는 키당 300회입니다.

---

## 2. 인증

### 2.1 API 키

기브싸인 사회복지기관 관리자 → **결제 설정 → 연동 API** 에서 발급합니다.

발급 시 두 값이 **한 번만** 표시됩니다.

| 값 | 용도 |
| --- | --- |
| `API 키` (`mp_live_…`) | 모든 요청의 `Authorization: Bearer` 헤더 |
| `서명 비밀키` | 쓰기 요청의 HMAC 서명 |

두 값 모두 기브싸인 서버에 **원문으로 저장되지 않습니다**(키는 해시, 서명 비밀키는 암호화).
분실하면 다시 볼 수 없으므로 폐기 후 재발급해야 합니다. 유출이 의심되면 즉시 폐기하세요.
유효한 키는 사회복지기관당 최대 3개입니다.

### 2.2 공통 헤더

```
Authorization: Bearer mp_live_xxxxxxxxxxxxxxxxxxxxxxxx
Content-Type: application/json          (POST 만)
X-Givesign-Timestamp: 1790000000        (POST 필수, GET 선택)
X-Givesign-Signature: <hex>             (POST 필수, GET 선택)
```

### 2.3 서명 (HMAC-SHA256)

상태를 바꾸는 요청(POST)에는 서명이 **필수**입니다. 조회(GET)는 생략할 수 있고,
보내면 검증합니다.

서명 원문은 마침표로 이은 네 조각입니다.

```
{timestamp}.{METHOD}.{path}.{rawBody}
```

- `timestamp` : **초 단위** Unix epoch. 밀리초를 보내면 오차 검사에서 거부됩니다.
- `METHOD`    : 대문자 (`GET`, `POST`)
- `path`      : 쿼리스트링을 **제외한** 경로 (`/api/partner/v1/charges/ack`)
- `rawBody`   : 전송하는 본문 문자열 그대로. GET 은 빈 문자열.

서명은 `hex` 소문자입니다.

```js
// Node.js 예시
const crypto = require('node:crypto');

function sign(secret, ts, method, path, body) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${ts}.${method.toUpperCase()}.${path}.${body}`)
    .digest('hex');
}

const ts = Math.floor(Date.now() / 1000).toString();
const body = JSON.stringify({ transactionNos: ['MP...'], status: 'SENT' });
const sig = sign(SIGNING_SECRET, ts, 'POST', '/api/partner/v1/charges/ack', body);
```

```python
# Python 예시
import hmac, hashlib, time, json

ts = str(int(time.time()))
body = json.dumps({"transactionNos": ["MP..."], "status": "SENT"}, separators=(",", ":"))
msg = f"{ts}.POST./api/partner/v1/charges/ack.{body}"
sig = hmac.new(SIGNING_SECRET.encode(), msg.encode(), hashlib.sha256).hexdigest()
```

> 서명 본문은 **실제로 전송하는 바이트와 같아야** 합니다. 직렬화한 문자열을 그대로
> 서명하고 그대로 전송하세요. 라이브러리가 다시 직렬화하면 서명이 어긋납니다.

- 타임스탬프 허용 오차: **±300초**. 서버 시계를 NTP 로 맞춰 주세요.
- 같은 서명은 재사용할 수 없습니다(재전송 차단, 600초간 기억).
  재시도할 때는 타임스탬프와 서명을 새로 만들어 보내세요.

---

## 3. 공통 응답 형식

성공

```json
{ "ok": true, "...": "..." }
```

실패

```json
{ "ok": false, "code": "INVALID_KEY", "message": "API 키가 올바르지 않습니다." }
```

`code` 로 분기하고 `message` 는 로그·표시용으로만 쓰세요.

| HTTP | code | 의미 |
| --- | --- | --- |
| 401 | `UNAUTHORIZED` | Authorization 헤더 없음 |
| 401 | `INVALID_KEY` | 키가 올바르지 않음 |
| 401 | `REVOKED_KEY` | 폐기된 키 |
| 401 | `SIGNATURE_REQUIRED` | 쓰기 요청에 서명 없음 |
| 401 | `SIGNATURE_INVALID` | 서명 불일치 |
| 401 | `SIGNATURE_EXPIRED` | 타임스탬프 오차 초과 |
| 403 | `MERCHANT_NOT_ACTIVE` | 사회복지기관 상태가 승인(APPROVED)이 아님 |
| 409 | `REPLAYED` | 같은 서명 재사용 |
| 429 | `RATE_LIMITED` | 분당 요청 한도 초과 |
| 400 | `INVALID_*` | 파라미터 오류 |
| 400 | `TRACKING_REQUIRED` | 발송 처리에 송장 정보 없음 |
| 400 | `NOT_PHYSICAL` | 배송 정보가 없는 주문 |
| 404 | `NOT_FOUND` | 해당 거래번호의 주문 없음 |

---

## 4. 엔드포인트

기본 주소: `https://<기브싸인 도메인>`

### 4.1 연결 점검

```
GET /api/partner/v1/ping
```

```json
{
  "ok": true,
  "merchantCode": "MC1234",
  "merchantName": "○○게임",
  "serverTime": "2026-08-31T02:00:00.000Z"
}
```

### 4.2 충전 건 조회

```
GET /api/partner/v1/charges?status=pending&limit=100
```

| 파라미터 | 기본값 | 설명 |
| --- | --- | --- |
| `status` | `pending` | `pending` = 아직 처리 통보하지 않은 건 / `all` = 전체 |
| `since` | – | ISO8601. 이 시각 이후 결제 건만 |
| `limit` | 100 | 1~500 |
| `cursor` | – | 직전 응답의 `nextCursor` |

정렬은 **결제 시각 오름차순**(오래된 건 먼저)입니다.

```json
{
  "ok": true,
  "items": [
    {
      "transactionNo": "MP20260831000123",
      "amount": 10000,
      "points": 10000,
      "currency": "KRW",
      "payerPhone": "01012345678",
      "payerPhoneMasked": "010****5678",
      "payerRef": "9f2c…",
      "message": "충전합니다",
      "channel": "MO",
      "chargeStatus": "PAYMENT_SUCCESS",
      "pointStatus": "PENDING",
      "paidAt": "2026-08-31T01:59:12.000Z",
      "test": false,
      "product": {
        "id": "01J...",
        "kind": "DIGITAL",
        "digitalType": "POINT",
        "name": "10,000 포인트",
        "sku": null,
        "giveAmount": 10000,
        "giveUnit": "포인트",
        "validDays": null
      },
      "quantity": 1,
      "optionText": null,
      "shippingFee": 0,
      "goodsAmount": 10000,
      "shipping": null
    }
  ],
  "nextCursor": null
}
```

| 필드 | 설명 |
| --- | --- |
| `transactionNo` | 기브싸인 거래번호. **ack 에 이 값을 씁니다.** |
| `amount` / `points` | 결제 금액(원)과 지급할 포인트. **1:1** 입니다. |
| `payerPhone` | 후원자 휴대폰 번호. 회원 매칭 기준 |
| `payerRef` | 번호를 저장하지 않으려는 사회복지기관용 고정 식별자. **사회복지기관마다 다른 값**이며, 같은 사회복지기관 안에서는 같은 번호 = 같은 값 |
| `pointStatus` | `PENDING`(대기) / `SENT`(완료) / `FAILED`(보류) |
| `test` | 테스트 결제 여부. `true` 면 적립하지 않는 것을 권장 |
| `product` | 고른 상품. 직접 입력 결제는 `null` |
| `quantity` | 주문 수량 (비실물은 항상 1) |
| `optionText` | 선택한 옵션 표기 (예: `사이즈: L / 색상: 블랙`) |
| `shippingFee` | 결제 금액에 포함된 배송비 (비실물은 0) |
| `goodsAmount` | `amount - shippingFee`. **포인트 적립은 이 값을 기준으로 하세요.** |
| `shipping` | 배송지. 실물 주문에만 있고 비실물은 `null` |

#### `product` 객체

| 필드 | 설명 |
| --- | --- |
| `kind` | `DIGITAL`(비실물) / `PHYSICAL`(실물) |
| `digitalType` | `POINT` / `VOUCHER`(상품권) / `PASS`(이용권). 실물이면 `null` |
| `name` / `sku` | 상품 이름 / 사회복지기관 상품 코드 |
| `giveAmount` | 지급할 수량. `null` 이면 `goodsAmount` 와 1:1 (포인트 기준) |
| `giveUnit` | 지급 단위 표기 (포인트 · 매 · 개월) |
| `validDays` | 이용권·상품권 유효기간(일). `null` 이면 무기한 |

#### `shipping` 객체 (실물 주문)

| 필드 | 설명 |
| --- | --- |
| `receiver` / `phone` | 받는 분 이름 / 연락처 |
| `zipCode` / `address` | 우편번호 / 주소 |
| `memo` | 배송 요청사항 |
| `remote` | 도서산간 여부 (추가 배송비가 붙은 주문) |
| `status` | `PREPARING` / `SHIPPED` / `DELIVERED` / `CANCELED` |
| `carrier` / `trackingNo` | 택배사 / 송장번호 |

> **배송지는 개인정보입니다.** 배송과 CS 목적으로만 쓰고, 그 외 이용·제3자 제공은 금지됩니다.
> 보관 기간이 지나면 파기해 주세요.

- `nextCursor` 가 `null` 이 아니면 같은 조건에 `cursor` 로 넣어 이어 받습니다.
- **환불된 건은 목록에 나오지 않습니다.** 이미 적립한 건이 환불되면 회수 책임은
  사회복지기관에 있습니다(§6).

### 4.3 처리 결과 통보 (ack)

```
POST /api/partner/v1/charges/ack
```

```json
{
  "transactionNos": ["MP20260831000123", "MP20260831000124"],
  "status": "SENT",
  "note": null
}
```

| 필드 | 필수 | 설명 |
| --- | --- | --- |
| `transactionNos` | ✔ | 최대 200건 |
| `status` | ✔ | `SENT`(적립 완료) 또는 `FAILED`(보류) |
| `note` | `FAILED` 일 때 필수 | 200자 이내. 보류 사유 |

```json
{
  "ok": true,
  "updated": 2,
  "unchanged": [],
  "unknown": []
}
```

| 필드 | 설명 |
| --- | --- |
| `updated` | 실제로 상태가 바뀐 건수 |
| `unchanged` | 이미 `SENT` 여서 바뀌지 않은 거래번호 |
| `unknown` | 이 사회복지기관 거래가 아니거나 존재하지 않는 거래번호 |

- **멱등**합니다. 같은 건을 다시 보내도 결과가 달라지지 않습니다.
- 한 번 `SENT` 로 확정된 건은 API 로 되돌릴 수 없습니다. 착오 적립은 기브싸인
  관리자에게 문의하세요.
- `FAILED` 로 보낸 건은 다시 `pending` 목록에 나옵니다. 사유를 해결한 뒤 다시
  적립하고 `SENT` 로 통보하면 됩니다.

---

### 4.4 배송 정보 등록 (실물)

```
POST /api/partner/v1/charges/shipment
```

```json
{
  "transactionNo": "MP20260831000125",
  "status": "SHIPPED",
  "carrier": "CJ대한통운",
  "trackingNo": "123456789012",
  "memo": null
}
```

| 필드 | 필수 | 설명 |
| --- | --- | --- |
| `transactionNo` | ✔ | 실물 주문의 거래번호 |
| `status` | ✔ | `PREPARING` / `SHIPPED` / `DELIVERED` / `CANCELED` |
| `carrier` / `trackingNo` | `SHIPPED` 일 때 필수 | 택배사 / 송장번호 |
| `memo` | – | 100자 이내. 후원자에게는 보이지 않습니다. |

```json
{ "ok": true, "transactionNo": "MP20260831000125", "status": "SHIPPED", "carrier": "CJ대한통운", "trackingNo": "123456789012" }
```

- 송장 없이 `SHIPPED` 로 바꾸면 `TRACKING_REQUIRED` 로 거절됩니다. 후원자가 배송을 조회할 수 없고, 분쟁 시
  발송 사실을 증명할 수 없기 때문입니다.
- 비실물 주문에 호출하면 `NOT_PHYSICAL` 로 거절됩니다.
- 발송 시각은 **처음 `SHIPPED` 로 바꾼 때만** 기록됩니다. 송장을 정정해도 원래 발송 시각은 유지됩니다.

---

## 5. 권장 구현 순서

1. `/ping` 으로 키와 서명이 맞는지 확인한다.
2. 1~5분 주기로 `/charges?status=pending&limit=100` 을 호출한다.
3. `nextCursor` 가 있으면 이어 받아 그 회차의 목록을 모두 가져온다.
4. `payerPhone`(또는 `payerRef`)로 회원을 찾는다.
   - 회원을 찾지 못하면 적립을 보류하고 `FAILED` + 사유로 통보한다.
     (기브싸인 관리자 화면에도 보류 사유가 표시되어 CS 응대가 쉬워집니다.)
5. `product.kind` 로 갈라 처리한다.
   - `DIGITAL` : `product.giveAmount`(없으면 `goodsAmount`) 만큼 포인트·상품권·이용권을 지급한다.
     **`amount` 가 아니라 `goodsAmount` 를 쓰세요.** 실물이 섞이면 배송비까지 적립하게 됩니다.
   - `PHYSICAL` : `shipping` 의 배송지로 출고하고, 송장이 나오면 `/charges/shipment` 로 등록한다.
6. 처리를 **사회복지기관 DB 트랜잭션 안에서** 하고, `transactionNo` 를 유니크 키로
   저장해 중복 적립·중복 출고를 막는다.
7. 성공한 건을 모아 `/charges/ack` 로 `SENT` 통보한다.

> **중복 적립 방지는 사회복지기관 책임입니다.**
> ack 가 네트워크 오류로 실패하면 같은 건이 다음 조회에 다시 나옵니다.
> `transactionNo` 를 유니크 제약으로 두면 재적립을 안전하게 막을 수 있습니다.

---

## 6. 환불·취소

- 환불은 기브싸인 관리자에서 처리하며, 환불된 건은 정산 원장에서 차감됩니다.
- **이미 적립한 포인트의 회수는 사회복지기관이 수행합니다.** 포인트를 발행한 주체가
  사회복지기관이기 때문입니다.
- 실물 주문을 환불하면 **아직 발송 전(PREPARING)** 인 경우 재고가 자동으로 복구되고 배송이
  `CANCELED` 로 바뀝니다. **이미 발송한 뒤(SHIPPED·DELIVERED)** 라면 물건이 나간 상태이므로
  재고를 되돌리지 않습니다. 회수와 재고 조정은 사회복지기관이 직접 처리합니다.
- 환불 사실은 기브싸인 관리자 화면의 결제 상세와 `status=all` 조회의
  `chargeStatus` 로 확인할 수 있습니다.

---

## 7. 정산

- 지급은 **사회복지기관이 요청하지 않습니다.** 최고관리자가 정한 지급일에 자동 지급됩니다.
- 지급일은 **결제일 + N영업일**(기본 D+5)이며, 전역 정책으로 일괄 지정하고
  사회복지기관별로 개별 조정할 수 있습니다. 현재 적용값은 사회복지기관 관리자 → 정산 관리 →
  지급 내역에서 확인할 수 있습니다.
- 영업일은 토·일과 공휴일을 제외한 날입니다.
- 사업자 사회복지기관은 원천징수 없이 전액 지급되고, 플랫폼 수수료는 세금계산서로
  발행됩니다. 개인 사회복지기관은 사업소득 3.3%가 원천징수됩니다.

---

## 8. 개인정보 처리

- `payerPhone` 은 개인정보입니다. 후원자가 사회복지기관 문자 수신번호로 MO 를 보냈기 때문에
  사회복지기관이 이미 보유한 정보이지만, **적립 목적 외 이용·제3자 제공은 금지**됩니다.
- 번호를 보관하고 싶지 않다면 `payerRef`(고정 식별자)만 저장해 회원과 매핑하세요.
  `payerRef` 는 사회복지기관마다 다른 값이 발급되므로, 다른 사회복지기관의 `payerRef` 와 대조해도
  같은 사람인지 알 수 없습니다(사회복지기관 간 후원자 추적 방지).
- 전송 구간은 TLS 1.2 이상만 허용합니다.
- API 키는 서버에만 두고 클라이언트(브라우저·앱)에 노출하지 마세요.

---

## 9. 변경 이력

| 버전 | 일자 | 내용 |
| --- | --- | --- |
| v1 | 2026-08-31 | 최초 작성 (charges 조회 / ack / ping) |
| v1.1 | 2026-09-01 | 상품(비실물·실물)·수량·옵션·배송지 필드 추가, `/charges/shipment` 추가 |
