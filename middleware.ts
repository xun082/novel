import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export function middleware(request: NextRequest) {
  const url = request.nextUrl.clone();
  const hadLegacyQuery = url.searchParams.has("step") || url.searchParams.has("view");

  if (!hadLegacyQuery) {
    return NextResponse.next();
  }

  url.searchParams.delete("step");
  url.searchParams.delete("view");

  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/"],
};
