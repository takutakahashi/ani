import { getConfig } from "@/src/config/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  getConfig();
  return Response.json({ status: "ok" });
}
