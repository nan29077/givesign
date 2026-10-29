import { ImageResponse } from 'next/og';
import { GiveSignMark } from '@/components/brand/logo';
export const size = { width: 64, height: 64 };
export const contentType = 'image/png';
export default function Icon() { return new ImageResponse(<GiveSignMark size={64} />, { ...size }); }
