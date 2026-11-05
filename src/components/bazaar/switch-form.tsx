'use client';

import * as React from 'react';
import { ActionForm } from '@/components/admin/action-form';
import { AdminInput } from '@/components/admin/controls';
import { setBazaarSwitchAction } from '@/app/actions/admin/bazaar';

/**
 * 라이브 바자회 활성화 스위치. 켜기는 바로, 끄기는 '끄기' 입력 확인을 거친다.
 * 진행 중 건수는 서버가 넘겨 준다(끄기 전에 무엇이 숨겨지는지 알 수 있게).
 */
export function BazaarSwitchForm({ enabled, canEdit, open }: { enabled: boolean; canEdit: boolean; open: { donations: number; listed: number; unpaid: number } }) {
  if (!canEdit) return <p className="text-[13px] text-ink-500">최고관리자만 바꿀 수 있습니다.</p>;
  if (!enabled) {
    return (
      <ActionForm action={setBazaarSwitchAction} submitLabel="라이브 바자회 켜기" confirm="라이브 바자회를 켜면 메인 화면·메뉴·기관 콘솔·기부자 콘솔에 바로 나타납니다. 켤까요?">
        <input type="hidden" name="enabled" value="on" />
      </ActionForm>
    );
  }
  return (
    <ActionForm action={setBazaarSwitchAction} submitLabel="라이브 바자회 끄기" variant="danger" confirm="라이브 바자회를 끄면 관련 화면·메뉴·메인 섹션이 모두 사라집니다. 끌까요?">
      <input type="hidden" name="enabled" value="off" />
      <div className="rounded-xl border border-warning-500/30 bg-warning-50 px-4 py-3 text-[13px] leading-relaxed text-ink-700">
        <p className="font-bold">끄기 전에 확인하세요</p>
        <ul className="mt-1 list-disc pl-5">
          <li>진행 중인 기부 {open.donations}건 · 셀러브릭스에 등록된(판매 중) 상품 {open.listed}개</li>
          <li>미지급 정산 {open.unpaid}건 — 끈 뒤에도 이 화면 아래 링크에서 지급 처리를 계속할 수 있습니다.</li>
          <li>셀러브릭스 쪽은 자동으로 숨겨지지 않습니다. 바자회 센터 창고 상품을 비활성으로 바꾸고 예정 방송을 취소해 주세요.</li>
          <li>발급된 현물 기부금영수증은 기관 기부금영수증 메뉴와 홈택스 명세에 그대로 남습니다.</li>
        </ul>
      </div>
      <label className="block">
        <span className="mb-1 block text-[12px] font-semibold text-ink-500">확인을 위해 &apos;끄기&apos; 를 입력하세요</span>
        <AdminInput name="confirmText" autoComplete="off" />
      </label>
    </ActionForm>
  );
}
