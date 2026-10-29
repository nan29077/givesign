import { ImageResponse } from 'next/og';
import { GiveSignMark } from '@/components/brand/logo';
export const size = { width: 180, height: 180 };
export const contentType = 'image/png';
export default function AppleIcon() { return new ImageResponse(<GiveSignMark size={180} />, { ...size }); }
