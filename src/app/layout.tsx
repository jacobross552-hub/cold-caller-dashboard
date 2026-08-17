import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cold caller dashboard",
  description: "Run and monitor the Jacob cold-calling agent",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-AU">
      <body>{children}</body>
    </html>
  );
}
