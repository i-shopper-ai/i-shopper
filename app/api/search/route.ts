import { NextResponse } from "next/server";
import { fetchCandidates } from "@/lib/api/serpApi";
import type { DetectedConstraint } from "@/lib/types/session";

export const maxDuration = 60;

export interface SearchRequestBody {
  queries: string[];
  constraints?: DetectedConstraint[];
  /** When true, returns a Server-Sent Events stream with preview thumbnails. */
  stream?: boolean;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as SearchRequestBody;
    const { queries, constraints = [], stream: useStream = false } = body;

    if (!Array.isArray(queries) || queries.length === 0) {
      return NextResponse.json(
        { error: "queries must be a non-empty array" },
        { status: 400 }
      );
    }

    // ── Non-streaming path (backward-compatible) ─────────────────────────────
    if (!useStream) {
      const candidates = await fetchCandidates(queries);
      return NextResponse.json({ candidates, constraints });
    }

    // ── Streaming SSE path ────────────────────────────────────────────────────
    // Emits `preview` events with thumbnail URLs as each query resolves,
    // then a final `done` event with the full deduplicated candidate list.
    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        const emit = (obj: unknown) =>
          controller.enqueue(encoder.encode(`data:${JSON.stringify(obj)}\n\n`));
        try {
          const candidates = await fetchCandidates(queries, (thumbnails) => {
            emit({ type: "preview", thumbnails });
          });
          emit({ type: "done", candidates, constraints });
        } catch (err) {
          console.error("[/api/search stream]", err);
          emit({ type: "error", message: String(err) });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err) {
    console.error("[/api/search]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
