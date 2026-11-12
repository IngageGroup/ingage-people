import type { Metadata } from "next";
import { SessionProvider } from "next-auth/react";
import "@ingagegroup/ingage-design-tokens/tokens.css";
import "@ingagegroup/ingage-react/styles.css";
import "./globals.css";
import AppChrome from "@/components/AppChrome";
import { APP_DESCRIPTION, APP_NAME } from "@/lib/app-config";

export const metadata: Metadata = {
  title: APP_NAME,
  description: APP_DESCRIPTION,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <SessionProvider>
          <AppChrome>{children}</AppChrome>
        </SessionProvider>
      </body>
    </html>
  );
}
