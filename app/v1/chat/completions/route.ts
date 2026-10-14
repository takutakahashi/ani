import { handleChatCompletions } from "@/src/server/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = handleChatCompletions;
