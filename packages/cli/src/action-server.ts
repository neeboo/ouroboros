import { applyHarnessAction, type Harness, type HarnessActionResult } from "@ouroboros/harness";

export interface HarnessActionServerOptions {
  harness: Harness;
  host?: string;
  port: number;
  token?: string | null;
}

export function serveHarnessActions(options: HarnessActionServerOptions) {
  return Bun.serve({
    hostname: options.host ?? "127.0.0.1",
    port: options.port,
    fetch(request) {
      return handleHarnessActionRequest(request, options);
    },
  });
}

export async function handleHarnessActionRequest(
  request: Request,
  options: Pick<HarnessActionServerOptions, "harness" | "token">,
) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return Response.json({ status: "ok" });
  }
  if (request.method !== "POST" || url.pathname !== "/actions") {
    return new Response("not found", { status: 404 });
  }
  if (options.token && bearerToken(request) !== options.token) {
    return Response.json({ error: "invalid harness action token" }, { status: 401 });
  }
  try {
    const action = await request.json();
    const result = applyHarnessAction(options.harness, action);
    return Response.json(result, { status: result.status === "done" ? 200 : 422 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function requestHarnessAction(input: {
  url: string;
  action: unknown;
  token?: string | null;
}): Promise<HarnessActionResult & { eventId?: string }> {
  const response = await fetch(new URL("/actions", input.url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
    },
    body: JSON.stringify(input.action),
  });
  const payload = await response.json();
  if (!response.ok && !payload.status) {
    throw new Error(payload.error ?? `harness action request failed with ${response.status}`);
  }
  return payload;
}

function bearerToken(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? "";
}
