import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { newId } from '../src/lib/id';
import { encrypt, phoneHash, maskPhone, maskSecret } from '../src/lib/crypto';
import { SEED_VERSION, SEED_VERSION_KEY } from './seed-version.mjs';
import { SEED_TERMS, TERMS_VERSION, TERMS_EFFECTIVE_FROM } from './terms-content';

// 운영 환경 가드: 시드는 테스트 계정(admin@givesign.kr 등)과 샘플 데이터를 만들므로
// 운영 DB 에서는 절대 실행하지 않는다. (APP_ENV 별칭 규칙은 src/lib/env.ts 와 동일하게 prod/production 을 본다)
const appEnv = (process.env.APP_ENV ?? '').trim().toLowerCase();
const isProd = appEnv === 'prod' || appEnv === 'production' || process.env.NODE_ENV === 'production';
if (isProd) {
  console.log('[seed] 운영 환경에서는 관리자 시드 계정을 생성하지 않습니다.');
  process.exit(0);
}

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('기브싸인 시드 데이터 생성 시작');

  // ---------------------------------------------------------------- 시스템 설정
  const settings: Array<[string, unknown, string]> = [
    ['payment.mode', 'CONFIRM_LINK', '전역 기본 결제 모드. DIRECT_TRIGGER 는 금융사 서면승인 후에만 허용'],
    ['payment.confirmTtlSec', 300, '결제 확인 링크 유효시간(초). 헥토 10분 제한보다 짧게 유지'],
    ['charge.defaultAmount', 3000, '문자 1건당 기본 결제 금액'],
    ['service.name', '기브싸인', '서비스명'],
  ];
  for (const [key, value, memo] of settings) {
    await prisma.systemSetting.upsert({
      where: { key },
      create: { key, value: value as object, memo },
      update: { value: value as object, memo },
    });
  }

  // ---------------------------------------------------------------- 약관
  // 약관 본문은 prisma/terms-content.ts 에 둔다(시드 파일이 길어지면 다른 시드가 묻힌다).
  for (const t of SEED_TERMS) {
    await prisma.termsVersion.upsert({
      where: { type_version: { type: t.type, version: TERMS_VERSION } },
      create: {
        id: newId(),
        type: t.type,
        version: TERMS_VERSION,
        title: t.title,
        content: t.content,
        required: t.required,
        effectiveFrom: TERMS_EFFECTIVE_FROM,
      },
      // 시드를 다시 돌리면 문안이 최신으로 맞춰지도록 갱신한다.
      update: { title: t.title, content: t.content, required: t.required },
    });
    // 같은 유형의 이전 버전은 비활성화한다. 활성 버전이 둘이면 동의 화면에 중복 노출된다.
    await prisma.termsVersion.updateMany({
      where: { type: t.type, version: { not: TERMS_VERSION }, active: true },
      data: { active: false },
    });
  }

  // ---------------------------------------------------------------- 정책
  const existingPolicy = await prisma.chargeLimitPolicy.findFirst({ where: { scope: 'GLOBAL' } });
  if (!existingPolicy) {
    await prisma.chargeLimitPolicy.create({ data: { id: newId(), scope: 'GLOBAL' } });
  }

  const existingFee = await prisma.feePolicy.findFirst({ where: { scope: 'GLOBAL' } });
  if (!existingFee) {
    await prisma.feePolicy.create({
      data: { id: newId(), scope: 'GLOBAL', pgFeeRate: '0.018', platformFeeRate: '0.15', smsCost: 20 },
    });
  }

  // ---------------------------------------------------------------- 금칙어
  const words: Array<[string, 'BLOCK' | 'MASK']> = [
    ['도박', 'BLOCK'], ['불법', 'BLOCK'], ['사기', 'MASK'],
    ['씨발', 'MASK'], ['개새끼', 'MASK'], ['죽여', 'BLOCK'],
  ];
  for (const [word, action] of words) {
    const exists = await prisma.bannedWord.findFirst({ where: { word, merchantId: null } });
    if (!exists) await prisma.bannedWord.create({ data: { id: newId(), word, action, scope: 'GLOBAL' } });
  }

  // ---------------------------------------------------------------- 관리자
  const adminUser = await prisma.user.upsert({
    where: { email: 'admin@givesign.kr' },
    create: {
      id: newId(), email: 'admin@givesign.kr', name: '기브싸인 관리자',
      role: 'ADMIN', passwordHash: await bcrypt.hash('givesign1234!', 10),
    },
    update: { role: 'ADMIN' },
  });
  await prisma.adminProfile.upsert({
    where: { userId: adminUser.id },
    create: { id: newId(), userId: adminUser.id, permission: 'SUPER_ADMIN' },
    update: { permission: 'SUPER_ADMIN' },
  });

  // ---------------------------------------------------------------- 사회복지기관
  const merchantSeeds = [
    { email: 'merchant1@givesign.kr', name: '햇살종합사회복지관', code: 'GIV-8K2M', mo: '05051001001', mode: 'DEDICATED' as const, keyword: null },
    { email: 'merchant2@givesign.kr', name: '함께걷는복지재단', code: 'GIV-3QP7', mo: '05059000000', mode: 'SHARED_PREFIX' as const, keyword: 'GIV3QP7' },
  ];

  for (const c of merchantSeeds) {
    const user = await prisma.user.upsert({
      where: { email: c.email },
      create: {
        id: newId(), email: c.email, name: c.name, role: 'MERCHANT',
        passwordHash: await bcrypt.hash('givesign1234!', 10),
      },
      update: { role: 'MERCHANT' },
    });

    const merchant = await prisma.merchantProfile.upsert({
      // 구버전 CreatorProfile에서 이름이 변경된 DB에도 동일 코드 행이 남아 있다.
      // 고정 시드 코드를 기준으로 재사용해야 userId가 달라져도 중복 코드 오류가 나지 않는다.
      where: { code: c.code },
      create: {
        id: newId(), userId: user.id, code: c.code, displayName: c.name,
        channelName: `${c.name}`, status: 'APPROVED',
        approvedAt: new Date(),
        description: '문자 한 통으로 이웃의 일상에 따뜻한 마음을 전합니다.',
        avatarUrl: '/assets/givesign/mascot.png',
      },
      // 과거 시드에서는 25개 캐릭터가 합쳐진 스프라이트 전체를 저장해 잘못 보였다.
      // 테스트 계정은 URL을 비우고 userId 기반 자동 캐릭터를 사용한다.
      update: { userId: user.id, status: 'APPROVED', avatarUrl: '/assets/givesign/mascot.png' },
    });

    // 상품. 비실물(포인트·상품권·이용권)과 실물을 함께 깔아 둔다.
    // 금액과 지급 포인트는 1:1 이 기본이다.
    const productCount = await prisma.chargeProduct.count({ where: { merchantId: merchant.id } });
    if (productCount === 0) {
      const presets = [3000, 5000, 10000, 30000];
      for (const [i, amount] of presets.entries()) {
        await prisma.chargeProduct.create({
          data: {
            id: newId(),
            merchantId: merchant.id,
            kind: 'DIGITAL',
            digitalType: 'POINT',
            name: `${amount.toLocaleString('ko-KR')}원 후원`,
            amount,
            giveAmount: amount,
            giveUnit: '후원',
            sortOrder: i,
          },
        });
      }
    }

    const codeExists = await prisma.merchantCode.findUnique({ where: { code: c.code } });
    if (!codeExists) {
      await prisma.merchantCode.create({ data: { id: newId(), merchantId: merchant.id, code: c.code, active: true } });
    }

    const moExists = await prisma.merchantMoNumber.findFirst({ where: { phoneNumber: c.mo, keyword: c.keyword } });
    if (!moExists) {
      await prisma.merchantMoNumber.create({
        data: {
          id: newId(), phoneNumber: c.mo, keyword: c.keyword, mode: c.mode,
          status: 'ASSIGNED', merchantId: merchant.id, providerId: 'mock',
          assignedAt: new Date(), monthlyCost: c.mode === 'DEDICATED' ? 30000 : 0,
        },
      });
    }


    await prisma.settlementAccount.upsert({
      where: { merchantId: merchant.id },
      create: {
        id: newId(), merchantId: merchant.id, bankCode: '004', bankName: 'KB국민은행',
        accountEnc: encrypt('11122233344455'), accountTail4: '4455',
        holderNameEnc: encrypt(c.name), holderMasked: `${c.name[0]}*${c.name.slice(2)}`,
        verified: true, verifiedAt: new Date(),
      },
      update: {},
    });
  }

  // ---------------------------------------------------------------- 테스트 후원자 (계좌 등록 완료 상태)
  const testPhone = '01012345678';
  const payer = await prisma.payerProfile.upsert({
    where: { phoneHash: phoneHash(testPhone) },
    create: {
      id: newId(), phoneHash: phoneHash(testPhone), phoneEnc: encrypt(testPhone),
      phoneMasked: maskPhone(testPhone), displayName: '테스트후원자',
      ageVerified: true, registeredAt: new Date(), onboardingStatus: 'REGISTERED',
    },
    update: { onboardingStatus: 'REGISTERED' },
  });
  const tokenExists = await prisma.paymentMethodToken.findFirst({ where: { payerId: payer.id, status: 'ACTIVE' } });
  if (!tokenExists) {
    const billKey = 'MOCKBILL-SEED-4455';
    await prisma.paymentMethodToken.create({
      data: {
        id: newId(), payerId: payer.id, provider: 'mock',
        billKeyEnc: encrypt(billKey), billKeyHint: maskSecret(billKey),
        bankCode: '004', bankName: 'KB국민은행', accountTail4: '4455',
      },
    });
  }

  // 후원자 웹 계정 (테스트 로그인용) — PayerProfile 과 휴대폰 번호 기준으로 연결한다.
  const payerUser = await prisma.user.upsert({
    where: { email: 'payer@givesign.kr' },
    create: {
      id: newId(), email: 'payer@givesign.kr', name: '테스트후원자',
      role: 'PAYER', passwordHash: await bcrypt.hash('givesign1234!', 10),
    },
    update: { role: 'PAYER' },
  });
  if (!payer.userId) {
    await prisma.payerProfile.update({ where: { id: payer.id }, data: { userId: payerUser.id } });
  }

  // ---------------------------------------------------------------- 옛 번호 샘플 정리
  // 050 전환 이전 번호(1588…)로 들어가 UNKNOWN_ROUTE 로 실패한 샘플 수신문자를 지운다.
  // 지워야 아래 샘플 결제 블록이 다시 실행되어 정상 데이터가 만들어진다.
  await prisma.moInboundMessage.deleteMany({
    where: { providerMessageId: { startsWith: 'SEED-MO-' }, result: 'UNKNOWN_ROUTE' },
  });

  // ---------------------------------------------------------------- 샘플 결제 이력
  // 실제 서비스 흐름(handleMoInbound → executePayment)을 그대로 사용해 생성한다.
  // 수기 INSERT 가 아니므로 결제 트랜잭션·정산 원장·MT 발송 기록까지 일관되게 만들어진다.
  // (mock 어댑터 기준이며, 이미 이력이 있으면 건너뛴다)
  const chargeCount = await prisma.charge.count({ where: { payerId: payer.id } });
  if (chargeCount === 0) {
    try {
      const { handleMoInbound, executePayment } = await import('../src/server/services/charge-flow');
      const { completePinAuthorization } = await import('../src/server/services/pin-authorization');
      const { requestRefund } = await import('../src/server/services/refund');
      const { confirmChargeAmount } = await import('../src/server/services/charge-select');
      const { readMockOutbox } = await import('../src/server/adapters/mt');

      /**
       * 후원자가 안내 문자의 링크를 눌러 후원 금액을 고르는 단계.
       *
       * MO 만으로는 금액이 정해지지 않는다(PENDING_AMOUNT). 실제 흐름과 같게 하려고
       * 발송된 mock MT 에서 링크 토큰을 꺼내 첫 번째 후원 항목을 고른 것으로 처리한다.
       */
      const pickAmount = async (chargeId: string) => {
        const mt = readMockOutbox(10).find((m) => m.template === 'SELECT_AMOUNT');
        const token = mt?.text.match(/\/r\/([A-Za-z0-9_-]+)/)?.[1];
        if (!token) return false;
        const charge = await prisma.charge.findUnique({ where: { id: chargeId }, select: { merchantId: true } });
        if (!charge) return false;
        const product = await prisma.chargeProduct.findFirst({
          where: { merchantId: charge.merchantId, active: true, archivedAt: null },
          orderBy: [{ sortOrder: 'asc' }, { amount: 'asc' }],
          select: { id: true },
        });
        if (!product) return false;
        const res = await confirmChargeAmount({ token, productId: product.id });
        return res.ok;
      };

      // 수신번호는 시드에 정의된 사회복지기관 MO 번호를 그대로 사용한다.
      // (번호 체계를 바꿀 때 이 목록을 같이 고치지 않으면 전부 UNKNOWN_ROUTE 로 실패한다)
      const moA = merchantSeeds[0].mo;
      const moB = merchantSeeds[1].mo;
      const kwB = merchantSeeds[1].keyword ? `${merchantSeeds[1].keyword} ` : '';
      const samples: Array<{ to: string; content: string; pay: boolean }> = [
        { to: moA, content: '따뜻한 한 끼를 응원합니다', pay: true },
        { to: moA, content: '아이들의 건강한 성장을 응원합니다', pay: true },
        { to: moA, content: '어르신의 일상을 응원합니다', pay: true },
        { to: moB, content: `${kwB}이웃을 후원합니다`, pay: true },
        { to: moA, content: '후원 요청', pay: false }, // 결제 전 단계(확인 대기/한도 차단)로 남긴다
      ];

      let refundTarget: string | null = null;
      for (let i = 0; i < samples.length; i += 1) {
        const s = samples[i];
        const result = await handleMoInbound({
          providerMessageId: `SEED-MO-${String(i + 1).padStart(3, '0')}`,
          providerCode: 'mock',
          receivedNumber: s.to,
          fromNumber: testPhone,
          content: s.content,
          messageType: 'SMS',
          receivedAt: new Date(Date.now() - (samples.length - i) * 86_400_000),
        });
        if (s.pay && result.chargeId) {
          // 금액 선택 단계를 먼저 통과시킨다. 실패하면(한도 차단 등) 그 상태 그대로 둔다.
          if (result.status === 'PENDING_AMOUNT' && !(await pickAmount(result.chargeId))) continue;

          const after = await prisma.charge.findUnique({
            where: { id: result.chargeId },
            select: { status: true },
          });
          // PIN 인증 흐름에서는 후원자가 PIN 을 입력한 것과 같은 경로로 결제를 마친다.
          // (직접 executePayment 를 부르면 인증 세션이 대기 상태로 남아 실제 데이터와 달라진다)
          if (after?.status === 'PENDING_PIN') await completePinAuthorization({ chargeId: result.chargeId });
          else if (after?.status === 'PENDING_PAYMENT' || after?.status === 'PENDING_CONFIRM') {
            await executePayment(result.chargeId);
          } else continue;
          if (i === 1) refundTarget = result.chargeId;
        }
      }

      // 환불 요청 상태 샘플 1건 (관리자 환불 큐 검수용)
      if (refundTarget) {
        await requestRefund({ chargeId: refundTarget, reason: '실수로 중복 발송했습니다.', requestedBy: 'payer' });
      }
      console.log('  샘플 결제 이력 5건 생성 (결제 완료·환불 요청·한도 차단 등 실제 흐름 그대로)');
    } catch (e) {
      console.warn('  샘플 결제 이력 생성 건너뜀:', (e as Error).message);
    }
  }

  // ---------------------------------------------------------------- 콘텐츠
  const posts: Array<{ type: string; title: string; body: string; category?: string; sortOrder: number }> = [
    { type: 'FAQ', title: '문자후원은 어떻게 이용하나요?', body: '사회복지기관이 안내한 결제 수신번호로 문자를 보내면 됩니다. 최초 1회 계좌 등록과 이용 동의가 필요하며, 최초 문자는 결제 처리되지 않습니다.', category: '이용방법', sortOrder: 1 },
    { type: 'FAQ', title: '최초 문자도 결제되나요?', body: '아니요. 최초 문자는 결제 처리되지 않고 계좌 등록 안내만 발송됩니다. 등록 완료 후 보내는 문자부터 결제가 접수됩니다.', category: '이용방법', sortOrder: 2 },
    { type: 'FAQ', title: '결제 한도가 있나요?', body: '기본 일일 100,000원, 1분 내 3건, 연속 5건 이후 대기시간이 적용됩니다. 한도는 마이페이지에서 더 낮게 설정할 수 있습니다.', category: '한도', sortOrder: 3 },
    { type: 'FAQ', title: '결제를 취소할 수 있나요?', body: '결제 직후 고객센터로 요청하시면 정산 전인 건에 한해 취소·환불이 가능합니다.', category: '환불', sortOrder: 4 },
    { type: 'FAQ', title: '후원 내역은 언제 확인할 수 있나요?', body: '결제 완료 후 후원 내역과 안내 문자에서 결과를 확인할 수 있습니다. 기관 정산은 별도의 정산 일정에 따라 진행됩니다.', category: '충전', sortOrder: 5 },
    { type: 'NOTICE', title: 'GiveSign 베타 서비스 안내', body: '현재 GiveSign(기브싸인)는 준비 단계이며 실제 결제와 문자 발송은 비활성화되어 있습니다.', sortOrder: 1 },
  ];
  for (const p of posts) {
    const exists = await prisma.contentPost.findFirst({ where: { type: p.type, title: p.title } });
    if (!exists) {
      await prisma.contentPost.create({
        data: { id: newId(), type: p.type, title: p.title, body: p.body, category: p.category ?? null, sortOrder: p.sortOrder },
      });
    }
  }

  // 과거 후원 서비스 시절의 고정 FAQ가 남아 있으면 공개 문의 위젯에 함께 노출된다.
  // 현재 결제·충전 FAQ가 생성된 뒤 정확히 일치하는 구형 시드 제목만 제거한다.
  await prisma.contentPost.deleteMany({
    where: {
      type: 'FAQ',
      title: {
        in: [
          '문자후원은 어떻게 이용하나요?',
          '최초 문자도 후원되나요?',
          '후원 한도가 있나요?',
          '후원을 취소할 수 있나요?',
          '후원금은 언제 정산되나요?',
        ],
      },
    },
  });
  await prisma.contentPost.deleteMany({
    where: { type: 'NOTICE', title: { in: ['기브싸인 베타 서비스 안내', '도네이도 베타 서비스 안내', '토네이도 베타 서비스 안내'] } },
  });

  // ---------------------------------------------------------------- 050 번호 전환
  // 시드 v5: MO 수신번호를 050(0505) 체계로 전환한다. 기존 DB 의 옛 1588 번호를 갱신한다.
  await prisma.merchantMoNumber.updateMany({ where: { phoneNumber: '15881001' }, data: { phoneNumber: '05051001001' } });
  await prisma.merchantMoNumber.updateMany({ where: { phoneNumber: '15889000' }, data: { phoneNumber: '05059000000' } });

  // ---------------------------------------------------------------- 브랜드명 정리
  // 브랜드명이 기브싸인로 바뀌기 전(토네이도 · 도네이도)에 만들어진 시드 데이터가 남아 있으면
  // 계정 이메일과 사회복지기관 코드 체계까지 달라지므로 `npm run db:reset` 으로 새로 만든다.

  // 시드 버전 기록. 다음 실행 때 이 값으로 보충 시드 필요 여부를 판단한다.
  await prisma.systemSetting.upsert({
    where: { key: SEED_VERSION_KEY },
    create: { key: SEED_VERSION_KEY, value: SEED_VERSION, memo: '적용된 시드 데이터 버전' },
    update: { value: SEED_VERSION },
  });

  console.log('시드 완료');
  console.log('  관리자     : admin@givesign.kr / givesign1234!');
  console.log('  사회복지기관 : merchant1@givesign.kr / givesign1234! (코드 GIV-8K2M, MO 0505-100-1001)');
  console.log('  사회복지기관 : merchant2@givesign.kr / givesign1234! (코드 GIV-3QP7, MO 0505-900-0000 + 키워드 GIV3QP7)');
  console.log('  후원자     : payer@givesign.kr / givesign1234! (010-1234-5678, 계좌 등록·계정 연결 완료)');
}

main()
  .then(async () => {
    await prisma.$disconnect();
    // 샘플 결제 이력 생성 시 동적 import 된 앱 모듈(별도 Prisma 클라이언트/Redis)이
    // 이벤트 루프를 붙잡아 프로세스가 종료되지 않는 것을 방지한다.
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
