import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "allinone × Next.js",
  description: "Next.js App Router integration example for the allinone platform",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
