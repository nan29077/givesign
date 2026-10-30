'use client';
import { Printer } from 'lucide-react';
export function DocumentPrintButton() { return <button type="button" onClick={() => window.print()} className="inline-flex items-center gap-2 rounded-xl border border-ink-200 bg-white px-4 py-2 text-sm font-bold print:hidden"><Printer size={16} />문서 인쇄·PDF 저장</button>; }
