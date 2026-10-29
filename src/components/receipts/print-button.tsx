'use client';

import { Printer } from 'lucide-react';
import { Button } from '@/components/ui';

export function PrintButton({ label = '인쇄 · PDF 저장' }: { label?: string }) {
  return (
    <Button type="button" variant="secondary" onClick={() => window.print()}>
      <Printer size={16} strokeWidth={1.7} /> {label}
    </Button>
  );
}
