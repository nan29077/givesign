import { Notice } from '@/components/ui';
import { getSessionUser } from '@/server/auth';

/**
 * 권한이 모자란 관리자에게 변경 동작이 막혀 있음을 미리 알린다.
 *
 * 서버 액션은 이미 등급을 검사해 거절하지만, 화면은 등급을 읽지 않아 위험한 버튼이
 * 모두 활성 상태로 보였다. 눌러 본 뒤에야 "권한이 없습니다" 를 만나는 죽은 버튼이 된다.
 * 콘솔 레이아웃에 한 번만 두어 모든 관리자 화면에 같은 안내가 뜨게 한다.
 */
export async function AdminPermissionBanner() {
  const me = await getSessionUser().catch(() => null);
  const permission = me?.adminPermission ?? '';

  if (permission === 'READ_ONLY') {
    return (
      <div className="mb-4">
        <Notice tone="warning" title="읽기 전용 권한입니다">
          조회만 할 수 있습니다. 이 콘솔의 등록·수정·승인·삭제 동작은 실행되지 않습니다.
          변경이 필요하면 최고 관리자에게 권한 상향을 요청해 주세요.
        </Notice>
      </div>
    );
  }

  if (permission === 'SUPPORT') {
    return (
      <div className="mb-4">
        <Notice tone="neutral" title="고객지원 권한입니다">
          결제·환불·정산·지급, 수수료·한도·약관·금칙어, 사회복지기관 심사와 코드/번호 배정,
          회원 상태 변경(정지·탈퇴), 사회복지기관 문자 템플릿 검수는 실행되지 않습니다.
          문의 응대와 조회, 그 밖의 일반 등록·수정은 그대로 사용할 수 있습니다.
        </Notice>
      </div>
    );
  }

  // adminProfile 행이 없는 계정은 등급이 비어 있다. 화이트리스트 판정이라 아무 변경도 되지 않는데
  // 아무 안내가 없으면 "버튼은 있는데 눌러도 안 되는" 화면이 된다.
  if (!permission) {
    return (
      <div className="mb-4">
        <Notice tone="warning" title="권한이 지정되지 않은 계정입니다">
          조회만 할 수 있습니다. 최고 관리자에게 등급 지정을 요청해 주세요.
        </Notice>
      </div>
    );
  }

  return null;
}
