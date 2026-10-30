import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { newId } from '../src/lib/id';
import { encrypt, phoneHash, maskPhone, maskSecret } from '../src/lib/crypto';
import { SEED_VERSION, SEED_VERSION_KEY } from './seed-version.mjs';
import { SEED_TERMS, TERMS_VERSION, TERMS_EFFECTIVE_FROM } from './terms-content';
import { DOCUMENT_PRESETS, fieldsToStorage } from '../src/server/services/documents';

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
    // 이전 버전은 그대로 둔다. 현행본은 시행일 기준으로 고르고(terms.ts) 유형당 1건만 노출되므로 중복되지 않으며,
    // 이전 버전에 걸린 동의 기록이 "개정 전 동의"로 남아 있어야 재동의(staleRequiredConsents)가 동작한다.
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
    { email: 'merchant1@givesign.kr', name: '햇살종합사회복지관', code: 'GIV-8K2M', mo: '158812341234', mode: 'DEDICATED' as const, keyword: null },
    { email: 'merchant2@givesign.kr', name: '함께걷는복지재단', code: 'GIV-3QP7', mo: '158812345678', mode: 'SHARED_PREFIX' as const, keyword: 'GIV3QP7' },
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
        // 기관 로고는 기관이 직접 올린다. 비워 두면 기본 캐릭터가 표시된다.
        avatarUrl: null,
      },
      // 과거 시드에서는 25개 캐릭터가 합쳐진 스프라이트 전체를 저장해 잘못 보였다.
      // 테스트 계정은 URL을 비우고 userId 기반 자동 캐릭터를 사용한다.
      update: { userId: user.id, status: 'APPROVED' },
    });

    // 공익법인 지정 확인(관리자 확인)이 생기기 전에 시드된 데모 기관도 영수증 발급을 시연할 수 있게 채운다.
    if (merchant.representativeName && merchant.designatedDonee && !merchant.designatedDoneeVerifiedAt) {
      await prisma.merchantProfile.update({
        where: { id: merchant.id },
        data: { designatedDoneeVerifiedAt: new Date('2026-01-02T00:00:00Z') },
      });
    }

    // 기관 정보(기부금영수증 발급 주체). 비어 있을 때만 채워 운영자가 바꾼 값을 덮지 않는다.
    if (!merchant.representativeName) {
      await prisma.merchantProfile.update({
        where: { id: merchant.id },
        data: {
          orgType: c.code === 'GIV-8K2M' ? 'WELFARE_FACILITY' : 'WELFARE_CORPORATION',
          businessNo: c.code === 'GIV-8K2M' ? '123-82-00001' : '456-82-00002',
          representativeName: c.code === 'GIV-8K2M' ? '김햇살' : '박함께',
          address: c.code === 'GIV-8K2M' ? '서울특별시 성북구 나눔로 12' : '경기도 수원시 팔달구 동행길 7',
          contactName: '후원팀',
          contactPhone: '02-000-0000',
          contactEmail: c.email,
          designatedDonee: true,
          designatedDoneeUntil: new Date('2029-12-31T00:00:00Z'),
          // 데모 기관은 관리자가 지정서를 확인한 상태로 둔다(영수증 발급 시연용).
          designatedDoneeVerifiedAt: new Date('2026-01-02T00:00:00Z'),
          donationCode: '40',
          fundraisingRegNo: c.code === 'GIV-8K2M' ? '2026-서울-00123' : null,
          fundraisingRegAuthority: c.code === 'GIV-8K2M' ? '서울특별시' : null,
        },
      });
    }

    // 공개 후원페이지. 없을 때만 만든다.
    await prisma.merchantDonationPage.upsert({
      where: { merchantId: merchant.id },
      create: {
        merchantId: merchant.id,
        title: c.code === 'GIV-8K2M' ? '작은 나눔이 이웃의 든든한 한 끼가 됩니다' : '함께 걷는 길 위에 희망을 놓습니다',
        subtitle: '문자 한 통에서 시작하는 따뜻한 변화',
        intro: '지역의 이웃과 함께 더 나은 일상을 만들어 갑니다. 보내주신 후원은 식사 지원, 돌봄, 긴급 생계 지원에 소중히 사용되며, 분기마다 사용 내역을 공개합니다.',
        heroUrl: '/assets/givesign/hero.png',
        color: c.code === 'GIV-8K2M' ? '#28634e' : '#1f4e79',
        thanks: '함께해 주셔서 감사합니다. 보내주신 마음을 이웃에게 전하겠습니다.',
        published: true,
      },
      update: {},
    });

    // 기관 전자문서 기본 서식. 기존에 수정하거나 보관한 서식은 덮어쓰지 않는다.
    for (const key of ['SUPPORT_AGREEMENT', 'VOLUNTEER_APPLICATION', 'PROGRAM_APPLICATION', 'GOODS_DONATION', 'CONSENT_PRIVACY']) {
      const preset = DOCUMENT_PRESETS.find(p => p.key === key)!;
      if (!(await prisma.documentTemplate.findFirst({ where: { merchantId: merchant.id, presetKey: key } }))) {
        await prisma.documentTemplate.create({ data: { id: newId(), merchantId: merchant.id, templateType: 'PRESET', presetKey: key, name: preset.name, description: preset.description, body: preset.body, fields: fieldsToStorage(preset.fields), requireSignature: preset.requireSignature } });
      }
    }
    // 상품. 비실물(포인트·상품권·이용권)과 실물을 함께 깔아 둔다.
    // 금액과 지급 포인트는 1:1 이 기본이다.
    const productCount = await prisma.chargeProduct.count({ where: { merchantId: merchant.id } });
    if (productCount === 0) {
      // 후원 항목: 금액대별 쓰임을 알려 주는 지정후원 용도. 금액은 그대로 후원금이다.
      const presets: Array<[number, string, string]> = [
        [5000, '따뜻한 한 끼', '어르신 도시락 1인분'],
        [10000, '아이들 간식 꾸러미', '지역아동센터 간식 1주'],
        [30000, '긴급 생계 지원', '위기가정 생필품 1세트'],
        [50000, '겨울 난방비', '취약가구 난방비 지원'],
      ];
      for (const [i, [amount, name, give]] of presets.entries()) {
        await prisma.chargeProduct.create({
          data: {
            id: newId(),
            merchantId: merchant.id,
            kind: 'DIGITAL',
            digitalType: 'POINT',
            name,
            description: give,
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

  // ---------------------------------------------------------------- 캠페인 · 정기후원 · 영수증 정보 (샘플)
  {
    const org = await prisma.merchantProfile.findUnique({ where: { code: 'GIV-8K2M' } });
    if (org) {
      const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
      const plus = (d: number) => new Date(Date.now() + 9 * 3600000 + d * 86_400_000).toISOString().slice(0, 10);
      const dateCol = (k: string) => new Date(`${k}T00:00:00Z`);
      const campaigns = [
        { code: '김장', title: '겨울 김장 나눔', summary: '홀몸 어르신 300가구에 김장김치를 전합니다', goal: 3_000_000, starts: plus(-20), ends: plus(40), status: 'ACTIVE' as const, featured: true,
          story: '매년 겨울, 혼자 사는 어르신들께 김장김치를 담가 전해 드립니다. 올해는 300가구를 목표로 합니다. 배추 1포기 값이 모여 한 가구의 겨울 밥상이 됩니다.',
          beneficiary: '성북구 거주 홀몸 어르신 300가구', usagePlan: '배추·양념 재료비 220만원, 포장·배송 50만원, 봉사자 식사 30만원' },
        { code: '학용품', title: '새 학기 학용품 꾸러미', summary: '지역아동센터 아동 120명에게 학용품을 선물했습니다', goal: 1_200_000, starts: plus(-120), ends: plus(-60), status: 'CLOSED' as const, featured: false,
          story: '새 학기를 앞둔 아이들에게 필요한 학용품을 꾸러미로 만들어 전달했습니다.', beneficiary: '지역아동센터 3곳 아동 120명', usagePlan: '학용품 세트 120개',
          resultReport: '후원해 주신 1,340,000원으로 학용품 꾸러미 134개를 마련해 3개 센터 아동 120명과 대기 아동 14명에게 전달했습니다. 남은 금액은 없습니다. 감사합니다.' },
      ];
      for (const [i, c] of campaigns.entries()) {
        const exists = await prisma.campaign.findUnique({ where: { merchantId_code: { merchantId: org.id, code: c.code } } });
        if (exists) continue;
        await prisma.campaign.create({
          data: {
            id: newId(), merchantId: org.id, code: c.code, title: c.title, summary: c.summary, story: c.story,
            beneficiary: c.beneficiary, usagePlan: c.usagePlan, goalAmount: BigInt(c.goal),
            startsOn: dateCol(c.starts), endsOn: dateCol(c.ends), status: c.status, featured: c.featured, sortOrder: i,
            resultReport: 'resultReport' in c ? c.resultReport : null, closedAt: c.status === 'CLOSED' ? new Date() : null,
          },
        });
      }

      // 테스트 후원자: 영수증 정보 + 정기후원 약정 (동의 기록 포함)
      const receiptTerms = await prisma.termsVersion.findFirst({ where: { type: 'RECEIPT_ISSUANCE', active: true } });
      const recurringTerms = await prisma.termsVersion.findFirst({ where: { type: 'RECURRING_DEBIT', active: true } });
      const { residentHash } = await import('../src/server/services/receipts');
      const { maskResident } = await import('../src/lib/crypto');
      const resident = '9001011234568'; // 체크섬이 맞는 테스트 번호
      if (receiptTerms && !(await prisma.payerReceiptProfile.findUnique({ where: { payerId: payer.id } }))) {
        const consent = await prisma.consentRecord.create({
          data: { id: newId(), userId: payer.userId, phoneHash: payer.phoneHash, termsId: receiptTerms.id, type: 'RECEIPT_ISSUANCE', agreed: true },
        });
        await prisma.payerReceiptProfile.create({
          data: {
            payerId: payer.id, legalName: '홍길동', residentNoEnc: encrypt(resident), residentNoHash: residentHash(resident),
            residentNoMasked: maskResident(resident), address: '서울특별시 성북구 테스트로 1', hometaxOptIn: true, consentId: consent.id,
          },
        });
      }
      if (recurringTerms && !(await prisma.recurringDonation.findFirst({ where: { payerId: payer.id, merchantId: org.id } }))) {
        const consent = await prisma.consentRecord.create({
          data: { id: newId(), userId: payer.userId, phoneHash: payer.phoneHash, termsId: recurringTerms.id, type: 'RECURRING_DEBIT', agreed: true },
        });
        const day = 25;
        const [y, m] = today.split('-').map(Number);
        const thisMonth = `${y}-${String(m).padStart(2, '0')}-${day}`;
        const next = thisMonth > today ? thisMonth : new Date(Date.UTC(y, m, day)).toISOString().slice(0, 10);
        await prisma.recurringDonation.create({
          data: {
            id: newId(), merchantId: org.id, payerId: payer.id, amount: 10000n, dayOfMonth: day, message: '매달 작은 마음을 보탭니다',
            status: 'ACTIVE', nextChargeOn: dateCol(next), cycleMonth: next.slice(0, 7), consentId: consent.id,
          },
        });
      }
      console.log('  캠페인 2건(모금 중·종료), 영수증 정보, 정기후원 약정 1건 생성');

      // 시드 v14: 자동화 데모 — 알림톡 채널(mock·사용 중), 콘텐츠 2건, 자원봉사 1건, 약정서, 기관 명단.
      // 모두 서비스 함수로 만든다(화면과 같은 규칙·멱등). 이미 있으면 건너뛴다.
      const svc = {
        alimtalk: await import('../src/server/services/alimtalk'),
        content: await import('../src/server/services/content'),
        volunteers: await import('../src/server/services/volunteers'),
        agreements: await import('../src/server/services/agreements'),
        supporters: await import('../src/server/services/supporters'),
      };
      if (!(await prisma.merchantAlimtalkChannel.findUnique({ where: { merchantId: org.id } }))) {
        const codes = Object.fromEntries(svc.alimtalk.ALIMTALK_TEMPLATES.map((c, i) => [c, `GS_DEMO_${String(i + 1).padStart(2, '0')}`]));
        await svc.alimtalk.saveAlimtalkChannel(org.id, { channelId: '@햇살복지관', senderKey: 'DEMOSENDERKEY0000000000000000000', templateCodes: codes });
        await prisma.merchantAlimtalkChannel.update({ where: { merchantId: org.id }, data: { status: 'ACTIVE', verifiedAt: new Date(), verifiedBy: 'seed', note: '데모 채널 (mock 발송)' } });
      }
      const kimjang = await prisma.campaign.findUnique({ where: { merchantId_code: { merchantId: org.id, code: '김장' } } });
      if (kimjang && (await prisma.contentItem.count({ where: { merchantId: org.id } })) === 0) {
        await prisma.merchantContentSetting.upsert({ where: { merchantId: org.id }, create: { merchantId: org.id, tone: 'WARM', hashtags: ['성북구', '김장나눔'] }, update: {} });
        for (const kind of ['SHORTFORM', 'IMAGE_SQUARE'] as const) {
          await svc.content.requestContent({ merchantId: org.id, campaignId: kimjang.id, kind, userId: org.userId });
        }
      }
      const live = await prisma.recurringDonation.findFirst({ where: { payerId: payer.id, merchantId: org.id } });
      if (live && !live.agreementDocId) await svc.agreements.issueRecurringAgreement(live.id, {}, { notify: false });
      if ((await prisma.volunteerApplication.count({ where: { merchantId: org.id } })) === 0) {
        await svc.volunteers.applyVolunteer({
          payerId: payer.id, merchantId: org.id, interests: ['급식·도시락', '돌봄·말벗'], availableDays: ['SAT'], timeSlot: 'WEEKEND',
          wish: '김장 나눔 행사', message: '주말에 시간이 됩니다.', safetyPledge: true, agree: true, source: 'INSTAGRAM',
        });
      }
      if ((await prisma.supporterContact.count({ where: { merchantId: org.id } })) === 0) {
        await svc.supporters.commitSupporterImport({
          merchantId: org.id, userId: org.userId, fileName: 'demo-후원의밤-2025.csv', consentConfirmed: true, consentBasis: '2025 후원의 밤 참가 신청서(데모)',
          csv: '이름,휴대폰,구분,태그\n김나눔,010-2000-0001,후원자,후원의밤\n이봉사,010-2000-0002,봉사자,급식\n박이웃,010-2000-0003,기타,후원의밤\n',
        });
      }
      console.log('  자동화 데모: 알림톡 채널(mock), 콘텐츠 2건, 자원봉사 신청 1건, 약정서, 기관 명단 3명');
    }
  }

  // ---------------------------------------------------------------- 콘텐츠
  const posts: Array<{ type: string; title: string; body: string; category?: string; sortOrder: number }> = [
    { type: 'FAQ', title: '문자후원은 어떻게 하나요?', body: '기관이 안내한 후원 수신번호로 응원 문자를 보내면 됩니다. 답장 문자의 링크에서 후원 금액을 고르고 PIN 을 입력하면 결제됩니다. 처음 한 번은 결제수단(내통장결제) 등록과 이용 동의가 필요하며, 등록 전 문자는 결제되지 않습니다.', category: '이용방법', sortOrder: 1 },
    { type: 'FAQ', title: '특정 캠페인을 지정해서 후원할 수 있나요?', body: '네. 문자 맨 앞에 캠페인 키워드(예: "김장 응원합니다")를 적으면 그 캠페인의 지정후원으로 집계됩니다. 금액 선택 화면에서도 캠페인을 고를 수 있습니다.', category: '이용방법', sortOrder: 2 },
    { type: 'FAQ', title: '기부금영수증은 어떻게 받나요?', body: '마이페이지 > 영수증에서 성명과 주민등록번호를 등록(동의)하면, 후원한 기관이 연말에 영수증을 발급하고 문자로 열람 링크를 보내 드립니다. 간소화 제출에 동의하면 국세청 연말정산 간소화에도 반영됩니다.', category: '영수증', sortOrder: 3 },
    { type: 'FAQ', title: '정기후원은 어떻게 신청하고 해지하나요?', body: '기관 후원페이지의 "매월 정기후원 신청" 에서 금액과 출금일을 정하면 등록된 결제수단에서 매월 자동 출금됩니다. 일시정지·해지는 마이페이지 > 정기후원에서 언제든 할 수 있습니다.', category: '정기후원', sortOrder: 4 },
    { type: 'FAQ', title: '후원 한도가 있나요?', body: '기본 일일 100,000원, 1분 내 3건, 연속 5건 이후 대기시간이 적용됩니다. 한도는 마이페이지에서 더 낮게 설정할 수 있습니다.', category: '한도', sortOrder: 5 },
    { type: 'FAQ', title: '후원을 취소할 수 있나요?', body: '결제 직후 고객센터로 요청하시면 정산 전인 건에 한해 취소·환불이 가능합니다. 환불된 후원은 기부금영수증에서 제외됩니다.', category: '환불', sortOrder: 6 },
    { type: 'NOTICE', title: '기브싸인 베타 서비스 안내', body: '현재 기브싸인(GIVESIGN)은 준비 단계이며 실제 결제와 문자 발송은 비활성화되어 있습니다.', sortOrder: 1 },
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
          '최초 문자도 결제되나요?',
          '최초 문자도 후원되나요?',
          '결제 한도가 있나요?',
          '결제를 취소할 수 있나요?',
          '후원 내역은 언제 확인할 수 있나요?',
          '충전은 언제 반영되나요?',
          '후원금은 언제 정산되나요?',
        ],
      },
    },
  });
  await prisma.contentPost.deleteMany({
    where: { type: 'NOTICE', title: { in: ['GiveSign 베타 서비스 안내', '메시지페이 베타 서비스 안내', '도네이도 베타 서비스 안내', '토네이도 베타 서비스 안내'] } },
  });

  // ---------------------------------------------------------------- 050 번호 전환
  // 검수 기관 MO 번호를 1588-1234-1234 체계로 사용한다.
  await prisma.merchantMoNumber.updateMany({ where: { phoneNumber: '15881001' }, data: { phoneNumber: '158812341234' } });
  await prisma.merchantMoNumber.updateMany({ where: { phoneNumber: '15889000' }, data: { phoneNumber: '158812345678' } });

  // ---------------------------------------------------------------- 브랜드명 정리
  // 브랜드명이 기브싸인으로 바뀌기 전(토네이도 · 도네이도)에 만들어진 시드 데이터가 남아 있으면
  // 계정 이메일과 사회복지기관 코드 체계까지 달라지므로 `npm run db:reset` 으로 새로 만든다.

  // 시드 버전 기록. 다음 실행 때 이 값으로 보충 시드 필요 여부를 판단한다.
  await prisma.systemSetting.upsert({
    where: { key: SEED_VERSION_KEY },
    create: { key: SEED_VERSION_KEY, value: SEED_VERSION, memo: '적용된 시드 데이터 버전' },
    update: { value: SEED_VERSION },
  });

  console.log('시드 완료');
  console.log('  관리자     : admin@givesign.kr / givesign1234!');
  console.log('  사회복지기관 : merchant1@givesign.kr / givesign1234! (코드 GIV-8K2M, MO 1588-1234-1234)');
  console.log('  사회복지기관 : merchant2@givesign.kr / givesign1234! (코드 GIV-3QP7, MO 1588-1234-5678 + 키워드 GIV3QP7)');
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
