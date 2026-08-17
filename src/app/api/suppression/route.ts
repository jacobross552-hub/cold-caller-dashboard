/**
 * The do-not-contact list: add a number by hand, or take one back off.
 *
 * Adding is the common case — someone rings back and asks to be removed, and
 * you want that recorded before the next lead run goes anywhere near them.
 */

import { NextResponse } from "next/server";
import { suppress, unsuppress } from "@/lib/suppression";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const form = await request.formData();
  const phone = String(form.get("phone") ?? "").trim();
  const action = String(form.get("action") ?? "add");

  const url = new URL("/leads", request.url);

  if (!phone) {
    url.searchParams.set("dncError", "Enter a phone number.");
    return NextResponse.redirect(url, { status: 303 });
  }

  const result =
    action === "remove"
      ? unsuppress(phone)
      : suppress(phone, String(form.get("reason") ?? "").trim() || "Asked not to be contacted.", {
          source: "manual",
          addedBy: "operator",
        });

  url.searchParams.set(result.ok ? "dncOk" : "dncError", result.detail);
  return NextResponse.redirect(url, { status: 303 });
}
