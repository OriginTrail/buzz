import { getRelayHttpUrl, signRelayEvent } from "@/shared/api/tauri";

const LOCAL_EXPLORER = "http://127.0.0.1:9295";
const LOCAL_PROBE_TIMEOUT_MS = 1_500;
const QUERY_TIMEOUT_MS = 25_000;
const NIP98_KIND = 27235;

export type ExplorerSource = "local" | "gateway";

export type DkgQueryOperation =
  | "channel_memory"
  | "contributor_trail"
  | "subgraph_graph"
  | "subgraph_triples"
  | "evidence";

type DkgQueryArguments = {
  channel_memory: Record<string, never>;
  contributor_trail: { pubkey: string };
  subgraph_graph: { name: string };
  subgraph_triples: { name: string };
  evidence: { uri: string };
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
    case "subgraph_graph":
    case "subgraph_triples":
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
  const relayHttpOrigin = (await getRelayHttpUrl()).replace(/\/+$/, "");
  const url = `${relayHttpOrigin}/api/dkg/query`;
  const body = JSON.stringify({
    channelId: query.channelId,
    operation: query.operation,
    arguments: query.arguments,
  });
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
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as {
      error?: unknown;
    } | null;
    const detail = typeof error?.error === "string" ? `: ${error.error}` : "";
    throw new Error(`community DKG query ${response.status}${detail}`);
  }
  const envelope = validateEnvelope(await response.json(), query);
  return adaptCommunityResult(envelope) as Result;
}

/**
 * Resolve a DKG read local-first, then through the authenticated active relay.
 * The gateway body is deliberately reconstructed from the operation contract;
 * `localPath` (and its receipt-derived CG) can never become authorization input.
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
