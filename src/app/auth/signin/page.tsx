"use client";

import { Button, Card, Divider, Logo } from "@ingagegroup/ingage-react";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { Suspense } from "react";
import { APP_NAME } from "@/lib/app-config";

function SignInForm() {
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") || "/";

  return (
    <main
      className="min-h-dvh flex items-center justify-center px-4"
      style={{ background: "var(--surface-page)" }}
    >
      <Card padding={40} className="w-full max-w-sm flex flex-col items-center text-center gap-5">
        <Logo height={32} basePath="/assets/logos" />
        <Divider variant="accent" />
        <div>
          <h1 className="text-2xl mb-1">{APP_NAME}</h1>
          <p style={{ color: "var(--text-muted)" }}>Sign in to continue</p>
        </div>
        <Button
          icon={null}
          onClick={() => void signIn("microsoft-entra-id", { callbackUrl })}
          style={{ width: "100%" }}
        >
          <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true">
            <rect x="1" y="1" width="9" height="9" fill="#f25022" />
            <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
            <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
            <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
          </svg>
          Sign in with Microsoft
        </Button>
      </Card>
    </main>
  );
}

export default function SignInPage() {
  return (
    <Suspense>
      <SignInForm />
    </Suspense>
  );
}
