import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Horseplay',
  description: 'Live pari-mutuel arbitrage signal tool',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
