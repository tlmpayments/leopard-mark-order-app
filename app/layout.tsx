import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "The Leopard Mark Brewing Co.",
  description: "Ordering for The Leopard Mark Brewing Co.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
