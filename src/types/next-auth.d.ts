import type { GraphTokens } from "@/lib/graph-token";

declare module "next-auth/jwt" {
  interface JWT {
    graph?: GraphTokens;
  }
}
