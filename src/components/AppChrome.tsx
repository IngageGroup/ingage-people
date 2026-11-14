"use client";

import { AppHeader, AppShell, Sidebar, type SidebarSection } from "@ingagegroup/ingage-react";
import { usePathname, useRouter } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { APP_NAME } from "@/lib/app-config";

const HOME = "/";

const SECTIONS: SidebarSection[] = [
  {
    items: [
      { id: "/", label: "Ask", icon: "ai-brain" },
      { id: "/notes", label: "Notes Sample", icon: "database" },
    ],
  },
];

/** AppShell + AppHeader + Sidebar around every page except the bare /auth/* pages. */
export default function AppChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session } = useSession();

  if (pathname.startsWith("/auth/")) return children;

  const user = session?.user;
  const userName = user?.name || user?.email;

  return (
    <AppShell
      style={{ height: "100dvh" }}
      header={
        <AppHeader
          appName={APP_NAME}
          homeHref={HOME}
          onLogoClick={() => router.push(HOME)}
          logoBasePath="/assets/logos"
          {...(userName ? { user: { name: userName } } : {})}
          onSignOut={() => void signOut({ callbackUrl: "/auth/signin" })}
        />
      }
      sidebar={
        <Sidebar sections={SECTIONS} value={pathname} onSelect={(href) => router.push(href)} />
      }
    >
      {children}
    </AppShell>
  );
}
