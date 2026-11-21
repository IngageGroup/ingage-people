import { findIana } from "windows-iana";
import { type FetchFn, graphJson } from "@/lib/graph/client";
import { isTimeZone } from "@/lib/validation";

/**
 * The user's Outlook time zone as an IANA name, or null when it isn't set or can't be
 * mapped. Outlook usually stores Windows names ("Eastern Standard Time"); those map to the
 * zone's main IANA name through the CLDR table in `windows-iana`.
 */
export async function mailboxTimeZone(token: string, fetchFn?: FetchFn): Promise<string | null> {
  const { value } = await graphJson<{ value?: unknown }>("/me/mailboxSettings/timeZone", {
    token,
    ...(fetchFn ? { fetchFn } : {}),
  });
  if (typeof value !== "string" || !value) return null;
  if (value.includes("/") && isTimeZone(value)) return value;
  const iana = findIana(value)[0];
  return iana && isTimeZone(iana) ? iana : null;
}
