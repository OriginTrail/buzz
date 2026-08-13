import { getRelayHttpUrl, signRelayEvent } from "@/shared/api/tauri";

const LOCAL_EXPLORER = "http://127.0.0.1:9295";
const LOCAL_PROBE_TIMEOUT_MS = 1_500;
const QUERY_TIMEOUT_MS = 25_000;
const NIP98_KIND = 27235;

export type ExplorerSource = "local" | "gateway";

export type DkgQueryOperation =
  | "channel_memory"
  | "contributor_trail"
  | "software_contributors"
  | "decision_trace"
  | "trust_network"
  | "reputation_summary"
  | "subgraph_graph"
  | "subgraph_triples"
  | "evidence"
  | "semantic_query";

type DkgQueryArguments = {
  channel_memory: Record<string, never>;
  contributor_trail: { pubkey: string };
  software_contributors: {
    repository: string;
    componentName: string;
    componentType?: "function" | "class" | "interface" | "file" | "package";
  };
  decision_trace: {
    repository: string;
    commitSha: string;
    componentName: string;
  };
  trust_network: Record<string, never>;
  reputation_summary: { pubkey: string };
  subgraph_graph: { name: string };
  subgraph_triples: { name: string };
  evidence: { uri: string };
  semantic_query: {
    sparql: string;
    view?: "both" | "shared" | "verified";
  };
};

type ProviderQuery<Operation extends DkgQueryOperation> = {
  channelId: string;
  operation: Operation;
  arguments: DkgQueryArguments[Operation];
  /** Local-only explorer path. Receipt-derived CGs never enter gateway bodies. */
  localPath: string | null;
};

type CommunityGatewayEnvelope = {
  ok: true;
  channelId: string;
  cg: string;
  operation: DkgQueryOperation;
  result: unknown;
};

type AuthenticatedDkgPost = {
  path: `/api/dkg/${string}`;
  body: string;
  timeoutMs?: number;
};

export class DkgProviderError extends Error {
  status: number;
  code?: string;
  details?: unknown;

  constructor(
    message: string,
    status: number,
    code?: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "DkgProviderError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let resolvedLocalExplorer: string | null | undefined;
let lastSource: ExplorerSource | null = null;

function isLoopbackExplorer(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "[::1]" ||
        url.hostname === "::1")
    );
  } catch {
    return false;
  }
}

function localExplorerCandidate(): string {
  try {
    const override = localStorage.getItem("dkg-memory-explorer-url");
    if (override && isLoopbackExplorer(override)) {
      return override.replace(/\/+$/, "");
    }
  } catch {
    // Storage is optional; use the loopback default.
  }
  return LOCAL_EXPLORER;
}

async function findLocalExplorer(): Promise<string | null> {
  if (resolvedLocalExplorer !== undefined) return resolvedLocalExplorer;
  const candidate = localExplorerCandidate();
  try {
    // Any HTTP response proves the optional explorer exists. Authorization and
    // graph membership are evaluated by the real operation immediately after.
    await fetch(`${candidate}/api/channel-memory?cg=probe`, {
      signal: AbortSignal.timeout(LOCAL_PROBE_TIMEOUT_MS),
    });
    resolvedLocalExplorer = candidate;
  } catch {
    resolvedLocalExplorer = null;
  }
  return resolvedLocalExplorer;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function dkgErrorMessage(
  payload: unknown,
  fallback: string,
): {
  message: string;
  code?: string;
  details?: unknown;
} {
  if (!isRecord(payload)) return { message: fallback };
  const error = payload.error;
  if (typeof error === "string") return { message: error };
  if (!isRecord(error)) return { message: fallback };
  return {
    message: typeof error.message === "string" ? error.message : fallback,
    code: typeof error.code === "string" ? error.code : undefined,
    details: error.details,
  };
}

/**
 * Shared authenticated JSON boundary for Buzz's channel-scoped DKG routes.
 * Every caller signs the exact serialized body and receives the same
 * structured error handling; feature modules only compose their payloads.
 */
export async function postAuthenticatedDkgJson<Result>({
  path,
  body,
  timeoutMs = QUERY_TIMEOUT_MS,
}: AuthenticatedDkgPost): Promise<{ result: Result; status: number }> {
  const relayHttpOrigin = (await getRelayHttpUrl()).replace(/\/+$/, "");
  const url = `${relayHttpOrigin}${path}`;
  const authEvent = await signRelayEvent({
    kind: NIP98_KIND,
    content: "",
    tags: [
      ["u", url],
      ["method", "POST"],
      ["payload", await sha256Hex(body)],
      ["nonce", crypto.randomUUID()],
    ],
  });
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Nostr ${btoa(JSON.stringify(authEvent))}`,
      "Content-Type": "application/json",
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = (await response.json().catch(() => null)) as Result | null;
  if (!response.ok) {
    const error = dkgErrorMessage(
      payload,
      `community DKG request failed (${response.status})`,
    );
    throw new DkgProviderError(
      error.message,
      response.status,
      error.code,
      error.details,
    );
  }
  return { result: (payload ?? {}) as Result, status: response.status };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSuccessfulLocalResult(value: unknown): boolean {
  if (Array.isArray(value)) return true;
  if (!isRecord(value)) return false;
  return !("gate" in value) || value.gate === "ok";
}

function protocolError(detail: string): Error {
  return new Error(`invalid community DKG response: ${detail}`);
}

function validateEnvelope<Operation extends DkgQueryOperation>(
  value: unknown,
  query: ProviderQuery<Operation>,
): CommunityGatewayEnvelope & { operation: Operation } {
  if (!isRecord(value) || value.ok !== true) {
    throw protocolError("expected a successful response envelope");
  }
  if (value.channelId !== query.channelId) {
    throw protocolError("channel does not match the request");
  }
  if (value.operation !== query.operation) {
    throw protocolError("operation does not match the request");
  }
  if (typeof value.cg !== "string" || value.cg.length === 0) {
    throw protocolError("missing Context Graph id");
  }
  return value as CommunityGatewayEnvelope & { operation: Operation };
}

function adaptCommunityResult<Operation extends DkgQueryOperation>(
  envelope: CommunityGatewayEnvelope & { operation: Operation },
): unknown {
  if (envelope.operation === "contributor_trail") {
    if (!isRecord(envelope.result) || !Array.isArray(envelope.result.trail)) {
      throw protocolError(
        "contributor_trail result must contain a trail array",
      );
    }
    return envelope.result.trail;
  }

  if (!isRecord(envelope.result)) {
    throw protocolError(`${envelope.operation} result must be an object`);
  }

  switch (envelope.operation) {
    case "channel_memory":
    case "software_contributors":
    case "decision_trace":
    case "trust_network":
    case "reputation_summary":
    case "subgraph_graph":
    case "subgraph_triples":
    case "semantic_query":
      return { ...envelope.result, gate: "ok", cg: envelope.cg };
    case "evidence":
      return { ...envelope.result, gate: "ok" };
    default:
      throw protocolError("unsupported operation");
  }
}

async function communityGatewayQuery<
  Result,
  Operation extends DkgQueryOperation,
>(query: ProviderQuery<Operation>): Promise<Result> {
  const body = JSON.stringify({
    channelId: query.channelId,
    operation: query.operation,
    ...(query.operation === "semantic_query"
      ? { scope: { type: "current_channel" } }
      : {}),
    arguments: query.arguments,
  });
  const { result } = await postAuthenticatedDkgJson<unknown>({
    path: "/api/dkg/query",
    body,
  });
  const envelope = validateEnvelope(result, query);
  return adaptCommunityResult(envelope) as Result;
}

/**
 * Resolve a DKG read local-first, then through the authenticated active relay.
 * The gateway body is deliberately reconstructed from the operation contract;
 * `localPath` and its locally resolved CG can never become authorization input.
 */
export async function queryDkgProvider<
  Result,
  Operation extends DkgQueryOperation,
>(query: ProviderQuery<Operation>): Promise<Result> {
  if (query.localPath) {
    const localExplorer = await findLocalExplorer();
    if (localExplorer) {
      try {
        const response = await fetch(`${localExplorer}${query.localPath}`, {
          signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
        });
        if (response.ok) {
          const result = (await response.json()) as unknown;
          if (isSuccessfulLocalResult(result)) {
            lastSource = "local";
            return result as Result;
          }
        }
      } catch {
        // The authenticated community provider is the next trust profile.
      }
      // Avoid retrying a failed local provider for every nested panel query.
      resolvedLocalExplorer = null;
    }
  }

  lastSource = null;
  const result = await communityGatewayQuery<Result, Operation>(query);
  lastSource = "gateway";
  return result;
}

/** Which provider most recently completed a DKG read. */
export function explorerSource(): ExplorerSource | null {
  return lastSource;
}

/** Clear community-scoped provider discovery when the active relay changes. */
export function resetDkgMemoryProvider(): void {
  resolvedLocalExplorer = undefined;
  lastSource = null;
}
