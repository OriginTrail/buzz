export type DkgMemoryCapabilities = {
  memory: boolean;
  semanticQuery: boolean;
};

type RelayCapabilityDocument = {
  dkg_memory?: unknown;
  supported_extensions?: unknown;
};

const capabilityByRelay = new Map<string, Promise<DkgMemoryCapabilities>>();

function hasString(values: unknown, expected: string): boolean {
  return Array.isArray(values) && values.some((entry) => entry === expected);
}

/** Parse the relay's NIP-11 document using the same fail-closed memory contract
 * as the ACP harness. Extension-only v1 remains compatible; v2 requires its
 * schema and profile descriptor.
 */
export function parseDkgMemoryCapabilities(
  document: unknown,
): DkgMemoryCapabilities {
  if (!document || typeof document !== "object") {
    return { memory: false, semanticQuery: false };
  }
  const capability = document as RelayCapabilityDocument;
  const supportsV1 = hasString(
    capability.supported_extensions,
    "buzz-dkg-memory-v1",
  );
  const supportsV2 = hasString(
    capability.supported_extensions,
    "buzz-dkg-memory-v2",
  );
  const descriptor =
    capability.dkg_memory && typeof capability.dkg_memory === "object"
      ? (capability.dkg_memory as {
          profiles?: unknown;
          query_operations?: unknown;
          schema_versions?: unknown;
        })
      : null;
  const descriptorSupportsV2 =
    supportsV2 &&
    Array.isArray(descriptor?.schema_versions) &&
    descriptor.schema_versions.some((version) => version === 2) &&
    hasString(descriptor.profiles, "dkg-memory@1");
  const memory = supportsV1 || descriptorSupportsV2;
  return {
    memory,
    semanticQuery:
      memory && hasString(descriptor?.query_operations, "semantic_query"),
  };
}

export function advertisesDkgMemory(document: unknown): boolean {
  return parseDkgMemoryCapabilities(document).memory;
}

export function advertisesDkgSemanticQuery(document: unknown): boolean {
  return parseDkgMemoryCapabilities(document).semanticQuery;
}

/**
 * Read and cache one typed capability decision per relay. Transport, HTTP, and
 * JSON failures evict themselves so later channel views or diagnostics retry.
 */
export function readDkgMemoryCapabilities(
  relay: string,
  readDocument: () => Promise<unknown> = async () => {
    const response = await fetch(`${relay}/`, {
      headers: { Accept: "application/nostr+json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Relay discovery returned ${response.status}.`);
    }
    return response.json();
  },
): Promise<DkgMemoryCapabilities> {
  const cached = capabilityByRelay.get(relay);
  if (cached) return cached;
  const request = readDocument().then(parseDkgMemoryCapabilities);
  capabilityByRelay.set(relay, request);
  void request.catch(() => {
    if (capabilityByRelay.get(relay) === request) {
      capabilityByRelay.delete(relay);
    }
  });
  return request;
}

export function resetDkgMemoryCapabilityCache(): void {
  capabilityByRelay.clear();
}
