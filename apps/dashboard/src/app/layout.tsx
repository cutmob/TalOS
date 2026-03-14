import type { Metadata, Viewport } from 'next';
import { Figtree } from 'next/font/google';

const figtree = Figtree({
  subsets: ['latin'],
  weight: ['300', '400', '600'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'TalOS — The AI Operating System',
  description: 'Voice-controlled AI operating system for enterprise software',
  icons: {
    icon: '/favicon.svg',
  },
  manifest: '/manifest.json',
};

export const viewport: Viewport = {
  themeColor: '#6366f1',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={figtree.className}>
      <body style={{ margin: 0, background: '#050505', color: '#e8e8e8', WebkitFontSmoothing: 'antialiased' }}>
        {children}
      </body>
    </html>
  );
}
