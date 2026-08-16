import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { sha256Text } from "../bounded-diagnostic";

const DEEPSEEK_API_ORIGIN = "https://api.deepseek.com";
const CHAT_COMPLETIONS_PATH = "/chat/completions";
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

export interface DshModelTransportReceipt {
  provider: "deepseek";
  endpointHostSha256: string;
  endpointPolicySha256: string;
  enforcement: "loopback-http-broker";
  credentialIsolation: true;
  requestCount: number;
  rejectedRequestCount: number;
}

export interface DshModelTransportBroker {
  baseUrl: string;
  clientApiKey: string;
  port: number;
  receipt(): DshModelTransportReceipt;
  cleanup(): Promise<void>;
}

interface DshModelTransportBrokerInput {
  apiKey: string | undefined;
  endpoint?: string;
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export async function prepareDshModelTransportBroker(
  input: DshModelTransportBrokerInput,
): Promise<DshModelTransportBroker> {
  const apiKey = input.apiKey?.trim();
  if (!apiKey) throw new Error("DSH model transport requires a host-owned DEEPSEEK_API_KEY");
  const endpoint = normalizeEndpoint(input.endpoint);
  const clientApiKey = `orbs-dsh-broker-${randomUUID()}`;
  const fetchImpl = input.fetchImpl ?? fetch;
  let requestCount = 0;
  let rejectedRequestCount = 0;
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== CHAT_COMPLETIONS_PATH) {
        rejectedRequestCount += 1;
        response.writeHead(404).end("not found");
        return;
      }
      if (request.headers.authorization !== `Bearer ${clientApiKey}`) {
        rejectedRequestCount += 1;
        response.writeHead(401).end("unauthorized");
        return;
      }
      const body = await readBoundedBody(request, MAX_REQUEST_BYTES);
      requestCount += 1;
      const upstream = await fetchImpl(`${endpoint}${CHAT_COMPLETIONS_PATH}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": request.headers["content-type"] ?? "application/json",
          accept: request.headers.accept ?? "text/event-stream",
        },
        body,
        redirect: "error",
      });
      response.statusCode = upstream.status;
      copyResponseHeader(upstream, response, "content-type");
      copyResponseHeader(upstream, response, "cache-control");
      copyResponseHeader(upstream, response, "x-request-id");
      if (!upstream.body) {
        response.end();
        return;
      }
      Readable.fromWeb(upstream.body as never).pipe(response);
    } catch (error) {
      if (!response.headersSent) response.writeHead(502);
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("DSH model transport broker did not bind a loopback port");
  }
  const endpointPolicy = {
    provider: "deepseek",
    origin: endpoint,
    method: "POST",
    path: CHAT_COMPLETIONS_PATH,
    maxRequestBytes: MAX_REQUEST_BYTES,
  };
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    clientApiKey,
    port: address.port,
    receipt: () => ({
      provider: "deepseek",
      endpointHostSha256: sha256Text(new URL(endpoint).hostname),
      endpointPolicySha256: sha256Text(JSON.stringify(endpointPolicy)),
      enforcement: "loopback-http-broker",
      credentialIsolation: true,
      requestCount,
      rejectedRequestCount,
    }),
    cleanup: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

function normalizeEndpoint(value: string | undefined) {
  const endpoint = (value ?? DEEPSEEK_API_ORIGIN).replace(/\/+$/, "");
  if (endpoint !== DEEPSEEK_API_ORIGIN) {
    throw new Error("DSH model transport endpoint must be the frozen DeepSeek API origin");
  }
  return endpoint;
}

async function readBoundedBody(request: AsyncIterable<Uint8Array>, limit: number) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) throw new Error("DSH model transport request exceeds the broker limit");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function copyResponseHeader(upstream: Response, response: ServerResponse, name: string) {
  const value = upstream.headers.get(name);
  if (value !== null) response.setHeader(name, value);
}
