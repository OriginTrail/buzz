import capabilityContract from "../../../../shared/dkg-memory/capability-contract.json" with {
  type: "json",
};

export type DkgMemoryCapabilities = {
  memory: boolean;
  semanticQuery: boolean;
  trust: boolean;
};

type RelayCapabilityDocument = {
  dkg_memory?: unknown;
  supported_extensions?: unknown;
};

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
    return { memory: false, semanticQuery: false, trust: false };
  }
  const capability = document as RelayCapabilityDocument;
  const supportsV1 = hasString(
    capability.supported_extensions,
    capabilityContract.memory.v1_extension,
  );
  const supportsV2 = hasString(
    capability.supported_extensions,
    capabilityContract.memory.v2_extension,
  );
  const descriptor =
    capability.dkg_memory && typeof capability.dkg_memory === "object"
      ? (capability.dkg_memory as {
          profiles?: unknown;
          query_operations?: unknown;
          schema_versions?: unknown;
          semantic_query?: unknown;
        })
      : null;
  const descriptorSupportsV2 =
    supportsV2 &&
    Array.isArray(descriptor?.schema_versions) &&
    descriptor.schema_versions.some(
      (version) => version === capabilityContract.memory.v2_schema_version,
    ) &&
    hasString(descriptor.profiles, capabilityContract.memory.v2_profile);
  const memory = supportsV1 || descriptorSupportsV2;
  const semanticDescriptor =
    descriptor?.semantic_query && typeof descriptor.semantic_query === "object"
      ? (descriptor.semantic_query as { forms?: unknown; scopes?: unknown })
      : null;
  const semanticQuery =
    memory &&
    hasString(
      descriptor?.query_operations,
      capabilityContract.semantic_query.operation,
    ) &&
    hasString(
      semanticDescriptor?.scopes,
      capabilityContract.semantic_query.scope,
    ) &&
    capabilityContract.semantic_query.required_forms.every((form) =>
      hasString(semanticDescriptor?.forms, form),
    );
  const trust =
    memory &&
    hasString(descriptor?.profiles, capabilityContract.trust.profile) &&
    hasString(descriptor?.query_operations, capabilityContract.trust.operation);
  return {
    memory,
    semanticQuery,
    trust,
  };
}

export function advertisesDkgMemory(document: unknown): boolean {
  return parseDkgMemoryCapabilities(document).memory;
}

export function advertisesDkgSemanticQuery(document: unknown): boolean {
  return parseDkgMemoryCapabilities(document).semanticQuery;
}

/** Fetch one typed capability decision. Query hooks own caching and retries. */
export async function fetchDkgMemoryCapabilities(
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
  return parseDkgMemoryCapabilities(await readDocument());
}
