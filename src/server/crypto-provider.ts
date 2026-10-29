import { env } from '@/lib/env';
import { setCryptoProvider, type CryptoProvider } from '@/lib/crypto';

/**
 * 암호화 provider 주입 지점.
 *
 * `src/lib/crypto.ts` 는 provider 를 "주입받는" 쪽이고, 어떤 구현을 쓸지는 여기서 정한다.
 * 부팅 훅(src/instrumentation.ts)에서 1회 호출한다.
 *
 * 절대 원칙
 *  - 실제 키 계약이 없는 provider 를 임의로 성공 처리하지 않는다.
 *    미구현 provider 가 지정되면 기동을 중단시킨다. (조용히 local 로 내려가면
 *    운영 데이터가 KMS 가 아닌 로컬 키로 암호화되어 되돌릴 수 없다)
 *  - local provider 는 crypto.ts 의 기본 구현이므로 주입하지 않는다.
 */

/**
 * AWS KMS 봉투암호화 provider.
 *
 * TODO(KMS 계약 후):
 *  1) `npm i @aws-sdk/client-kms` 로 SDK 를 추가한다.
 *  2) GenerateDataKey 로 데이터키를 발급받아 평문키로 AES-256-GCM 암호화하고,
 *     암호문에는 **암호화된 데이터키**를 함께 담는다. (형식: v1:kms:<encDataKey>:<iv>:<tag>:<ct>)
 *  3) 복호화는 Decrypt 로 데이터키를 푼 뒤 같은 방식으로 되돌린다.
 *  4) 데이터키는 요청마다 새로 발급받지 말고 짧은 TTL 로 캐시한다(KMS 호출 비용/한도).
 *  5) 기존 v1:local 암호문을 함께 읽을 수 있도록 복호화는 접두어로 분기한다(무중단 전환).
 *
 * 지금은 구조만 잡혀 있으며 실제 KMS 호출은 없다.
 */
function createKmsProvider(): CryptoProvider {
  throw new Error(
    'CRYPTO_PROVIDER=aws-kms 가 지정되었지만 KMS provider 가 아직 구현되지 않았습니다. ' +
      'src/server/crypto-provider.ts 의 createKmsProvider() 를 구현하거나, ' +
      '운영 배포 전까지는 다른 환경에서 CRYPTO_PROVIDER=local 로 검수해 주세요.',
  );
}

export async function installCryptoProvider(): Promise<void> {
  switch (env.crypto.provider) {
    case 'local':
      // crypto.ts 의 기본 구현(로컬 AES-256-GCM)을 그대로 사용한다.
      return;
    case 'aws-kms':
      setCryptoProvider(createKmsProvider());
      return;
    default:
      throw new Error(`[crypto] 알 수 없는 CRYPTO_PROVIDER 값입니다: ${env.crypto.provider}`);
  }
}
