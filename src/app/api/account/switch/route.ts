import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as
      | { account_id?: unknown }
      | null;
    const accountId = body?.account_id;

    if (typeof accountId !== "string" || !accountId.trim()) {
      return NextResponse.json(
        { error: "'account_id' is required" },
        { status: 400 },
      );
    }

    const ctx = await getCurrentAccount();
    const membership = ctx.memberships.find((m) => m.accountId === accountId);

    if (!membership) {
      return NextResponse.json(
        { error: "You are not a member of that account" },
        { status: 403 },
      );
    }

    const cookieStore = await cookies();
    cookieStore.set("wacrm_account_id", accountId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });

    return NextResponse.json({
      account: {
        id: membership.accountId,
        name: membership.accountName,
      },
      role: membership.role,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
