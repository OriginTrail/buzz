import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent } from "@/shared/api/tauri";
import type { RelayEvent } from "@/shared/api/types";
import type { WorkEvidence } from "./api";
import { postAuthenticatedDkgJson } from "./provider";
import {
  memoryProposalProgress,
  normalizeMemoryProposalResponse,
} from "./proposalState";

const HEX_PUBKEY = /^[0-9a-f]{64}$/iu;
const HEX_EVENT = /^[0-9a-f]{64}$/iu;
const SAFE_EVIDENCE_URI = /^(?:https:\/\/|urn:)[^<>"{}|^`\\\s]{1,995}$/u;
const TRUST_PROJECTION_OUTBOX_KEY = "buzz-dkg-trust-projections.v1";

interface PendingTrustProjection {
  channelId: string;
  sourceEventId: string;
  sourceEvent: RelayEvent;
  sourcePublished: boolean;
  proposalBody: string;
}

interface MemoryProposalResponse {
  state?: string;
  internalState?: string;
}

function eventIdFromUri(value: string | null): string | null {
  if (!value) return null;
  const eventId = value.startsWith("urn:nostr:event:")
    ? value.slice("urn:nostr:event:".length)
    : value;
  return HEX_EVENT.test(eventId) ? eventId.toLowerCase() : null;
}

function normalizeTrustText(value: string, maxBytes: number): string {
  const normalized = value
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized || new TextEncoder().encode(normalized).length > maxBytes) {
    throw new Error(`Text must contain 1–${maxBytes} UTF-8 bytes.`);
  }
  return normalized;
}

function boundedDisplayName(value: string, fallback: string): string {
  const normalized = value
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  let bytes = 0;
  let result = "";
  for (const character of normalized) {
    const size = new TextEncoder().encode(character).length;
    if (bytes + size > 500) break;
    bytes += size;
    result += character;
  }
  return result || fallback;
}

function readProjectionOutbox(): PendingTrustProjection[] {
  try {
    const value = JSON.parse(
      localStorage.getItem(TRUST_PROJECTION_OUTBOX_KEY) ?? "[]",
    );
    if (!Array.isArray(value)) return [];
    return value.filter(
      (entry): entry is PendingTrustProjection =>
        typeof entry?.channelId === "string" &&
        typeof entry?.sourceEventId === "string" &&
        HEX_EVENT.test(entry.sourceEventId) &&
        typeof entry?.sourceEvent === "object" &&
        entry.sourceEvent !== null &&
        entry.sourceEvent.id === entry.sourceEventId &&
        typeof entry?.sourcePublished === "boolean" &&
        typeof entry?.proposalBody === "string" &&
        entry.proposalBody.length <= 128 * 1_024,
    );
  } catch {
    return [];
  }
}

function writeProjectionOutbox(entries: PendingTrustProjection[]): boolean {
  try {
    if (entries.length === 0) {
      localStorage.removeItem(TRUST_PROJECTION_OUTBOX_KEY);
    } else {
      localStorage.setItem(
        TRUST_PROJECTION_OUTBOX_KEY,
        JSON.stringify(entries.slice(-50)),
      );
    }
    return true;
  } catch {
    return false;
  }
}

function queueProjection(entry: PendingTrustProjection): boolean {
  const entries = readProjectionOutbox().filter(
    (candidate) => candidate.sourceEventId !== entry.sourceEventId,
  );
  entries.push(entry);
  return writeProjectionOutbox(entries);
}

function clearProjection(sourceEventId: string): void {
  writeProjectionOutbox(
    readProjectionOutbox().filter(
      (entry) => entry.sourceEventId !== sourceEventId,
    ),
  );
}

async function postTrustMemoryProposal(
  body: string,
): Promise<MemoryProposalResponse> {
  const { result, status } =
    await postAuthenticatedDkgJson<MemoryProposalResponse>({
      path: "/api/dkg/memory",
      body,
    });
  return { ...result, ...normalizeMemoryProposalResponse(result, status) };
}

async function publishAndProjectTrustSource(
  channelId: string,
  source: RelayEvent,
  content: Record<string, unknown>,
): Promise<{ eventId: string; state?: string }> {
  const proposal = await signRelayEvent({
    kind: 40009,
    content: JSON.stringify(content),
    tags: [
      ["h", channelId],
      ["t", "dkg-memory-proposal"],
      ["e", source.id, "", "source"],
    ],
  });
  const pending = {
    channelId,
    sourceEventId: source.id,
    sourceEvent: source,
    sourcePublished: false,
    proposalBody: JSON.stringify(proposal),
  };
  const durable = queueProjection(pending);
  try {
    await relayClient.publishEvent(
      source,
      "The signed trust event timed out before the relay confirmed it.",
      "The relay could not publish the signed trust event.",
    );
    pending.sourcePublished = true;
    queueProjection(pending);
  } catch (cause) {
    if (!durable) throw cause;
    return { eventId: source.id, state: "projection_pending" };
  }

  const deadline = Date.now() + 120_000;
  try {
    do {
      const result = await postTrustMemoryProposal(pending.proposalBody);
      if (memoryProposalProgress(result.state) !== "processing") {
        clearProjection(source.id);
        return { eventId: source.id, state: result.state };
      }
      await new Promise((resolve) => window.setTimeout(resolve, 2_000));
    } while (Date.now() < deadline);
    return { eventId: source.id, state: "processing" };
  } catch (cause) {
    if (!durable) throw cause;
    return { eventId: source.id, state: "projection_pending" };
  }
}

/** Retry exact signed graph proposals without publishing duplicate trust events. */
export async function retryPendingTrustProjections(
  channelId: string,
): Promise<{ completed: number; remaining: number }> {
  const pending = readProjectionOutbox().filter(
    (entry) => entry.channelId === channelId,
  );
  let completed = 0;
  for (const entry of pending) {
    try {
      if (!entry.sourcePublished) {
        await relayClient.publishEvent(
          entry.sourceEvent,
          "The queued trust event timed out before the relay confirmed it.",
          "The relay could not publish the queued trust event.",
        );
        entry.sourcePublished = true;
        queueProjection(entry);
      }
      const result = await postTrustMemoryProposal(entry.proposalBody);
      if (memoryProposalProgress(result.state) === "stored") {
        clearProjection(entry.sourceEventId);
        completed += 1;
      }
    } catch {
      // Keep the exact signed proposal queued for the next bounded retry.
    }
  }
  return {
    completed,
    remaining: readProjectionOutbox().filter(
      (entry) => entry.channelId === channelId,
    ).length,
  };
}

/** Publish a human-signed vouch and project its exact evidence into channel memory. */
export async function publishTrustVouch({
  channelId,
  subjectPubkey,
  subjectName,
  note,
  evidence = [],
  supersedesEventId,
}: {
  channelId: string;
  subjectPubkey: string;
  subjectName: string;
  note: string;
  evidence?: WorkEvidence[];
  supersedesEventId?: string | null;
}): Promise<{
  eventId: string;
  state?: string;
  lifecycleEventId?: string;
  lifecycleState?: string;
}> {
  const subject = subjectPubkey.toLowerCase();
  const displayName = boundedDisplayName(subjectName, subject.slice(0, 12));
  let normalizedNote: string;
  if (!HEX_PUBKEY.test(subject)) throw new Error("Invalid vouch subject.");
  try {
    normalizedNote = normalizeTrustText(note, 1_000);
  } catch {
    throw new Error("A vouch explanation must contain 1–1,000 UTF-8 bytes.");
  }
  const selectedEvidence = [
    ...new Map(evidence.map((item) => [item.uri, item])).values(),
  ]
    .filter((item) => SAFE_EVIDENCE_URI.test(item.uri))
    .slice(0, 8);
  const evidenceSourceIds = [
    ...new Set(
      selectedEvidence
        .map((item) => eventIdFromUri(item.sourceEvent))
        .filter((sourceId): sourceId is string => sourceId !== null),
    ),
  ];
  const vouch = await signRelayEvent({
    kind: 1985,
    content: normalizedNote,
    tags: [
      ["h", channelId],
      ["L", "buzz.wot"],
      ["l", "vouch", "buzz.wot"],
      ["p", subject],
      ...selectedEvidence.map((item) => ["r", item.uri]),
      ...evidenceSourceIds.map((sourceId) => ["e", sourceId, "", "evidence"]),
    ],
  });
  if (vouch.pubkey.toLowerCase() === subject) {
    throw new Error("You cannot vouch for your own identity.");
  }
  const issuer = vouch.pubkey.toLowerCase();
  const result = await publishAndProjectTrustSource(channelId, vouch, {
    schemaVersion: 2,
    profiles: ["dkg-memory@1", "dkg-trust@1"],
    summary: `Vouch for ${displayName}`,
    entities: [
      {
        id: "vouch",
        type: "trust:Vouch",
        name: `Vouch for ${displayName}`,
        description: normalizedNote,
        locator: { kind: "uri", uri: `urn:buzz-dkg:vouch:${vouch.id}` },
        attributes: [
          { predicate: "trust:status", value: "active" },
          { predicate: "trust:scope", value: "channel" },
        ],
      },
      {
        id: "issuer",
        type: "schema:Person",
        name: "Vouch issuer",
        locator: { kind: "uri", uri: `urn:nostr:pubkey:${issuer}` },
      },
      {
        id: "subject",
        type: "schema:Person",
        name: displayName,
        locator: { kind: "uri", uri: `urn:nostr:pubkey:${subject}` },
      },
      ...selectedEvidence.map((item, index) => {
        const sourceId = eventIdFromUri(item.sourceEvent);
        return {
          id: `evidence-${index + 1}`,
          type: "trust:EvidenceReference",
          name: "Evidence reference",
          attributes: [
            { predicate: "trust:evidenceTarget", value: item.uri },
            ...(sourceId
              ? [
                  {
                    predicate: "trust:evidenceSource",
                    value: `urn:nostr:event:${sourceId}`,
                  },
                ]
              : []),
          ],
        };
      }),
    ],
    relations: [
      { subject: "vouch", predicate: "trust:issuer", object: "issuer" },
      { subject: "vouch", predicate: "trust:subject", object: "subject" },
      ...selectedEvidence.map((_, index) => ({
        subject: "vouch",
        predicate: "trust:supportedBy",
        object: `evidence-${index + 1}`,
      })),
    ],
    promptVersion: "human-vouch-v2",
  });
  if (!supersedesEventId) return result;
  const lifecycle = await publishTrustVouchLifecycle({
    channelId,
    subjectPubkey: subject,
    targetEventId: supersedesEventId,
    action: "supersede",
    replacementEventId: vouch.id,
    reason: "Replaced by a newer signed vouch and evidence selection.",
  });
  return {
    ...result,
    state:
      result.state === "projection_pending" ||
      lifecycle.state === "projection_pending"
        ? "projection_pending"
        : result.state === "processing" || lifecycle.state === "processing"
          ? "processing"
          : result.state,
    lifecycleEventId: lifecycle.eventId,
    lifecycleState: lifecycle.state,
  };
}

async function publishTrustVouchLifecycle({
  channelId,
  subjectPubkey,
  targetEventId,
  action,
  replacementEventId,
  reason,
}: {
  channelId: string;
  subjectPubkey: string;
  targetEventId: string;
  action: "revoke" | "supersede";
  replacementEventId?: string;
  reason: string;
}): Promise<{ eventId: string; state?: string }> {
  const subject = subjectPubkey.toLowerCase();
  const target = targetEventId.toLowerCase();
  const replacement = replacementEventId?.toLowerCase();
  let normalizedReason: string;
  if (!HEX_PUBKEY.test(subject) || !HEX_EVENT.test(target)) {
    throw new Error("Invalid vouch lifecycle target.");
  }
  if (
    (action === "supersede" &&
      (!replacement || !HEX_EVENT.test(replacement))) ||
    (action === "revoke" && replacement)
  ) {
    throw new Error("Invalid replacement vouch.");
  }
  try {
    normalizedReason = normalizeTrustText(reason, 1_000);
  } catch {
    throw new Error("A lifecycle reason must contain 1–1,000 UTF-8 bytes.");
  }
  const lifecycle = await signRelayEvent({
    kind: 1985,
    content: normalizedReason,
    tags: [
      ["h", channelId],
      ["L", "buzz.wot"],
      ["l", action, "buzz.wot"],
      ["p", subject],
      ["e", target, "", "target"],
      ...(replacement ? [["e", replacement, "", "replacement"]] : []),
    ],
  });
  const issuer = lifecycle.pubkey.toLowerCase();
  const status = action === "revoke" ? "revoked" : "superseded";
  return publishAndProjectTrustSource(channelId, lifecycle, {
    schemaVersion: 2,
    profiles: ["dkg-memory@1", "dkg-trust@1"],
    summary: action === "revoke" ? "Revoke vouch" : "Supersede vouch",
    entities: [
      {
        id: "lifecycle",
        type: "trust:VouchLifecycle",
        name: action === "revoke" ? "Revoke vouch" : "Supersede vouch",
        description: normalizedReason,
        locator: {
          kind: "uri",
          uri: `urn:buzz-dkg:vouch-lifecycle:${lifecycle.id}`,
        },
        attributes: [
          { predicate: "trust:status", value: status },
          { predicate: "trust:scope", value: "channel" },
          {
            predicate: "trust:targetVouch",
            value: `urn:buzz-dkg:vouch:${target}`,
          },
          ...(replacement
            ? [
                {
                  predicate: "trust:replacementVouch",
                  value: `urn:buzz-dkg:vouch:${replacement}`,
                },
              ]
            : []),
        ],
      },
      {
        id: "issuer",
        type: "schema:Person",
        name: "Vouch issuer",
        locator: { kind: "uri", uri: `urn:nostr:pubkey:${issuer}` },
      },
      {
        id: "subject",
        type: "schema:Person",
        name: "Vouch subject",
        locator: { kind: "uri", uri: `urn:nostr:pubkey:${subject}` },
      },
    ],
    relations: [
      { subject: "lifecycle", predicate: "trust:issuer", object: "issuer" },
      { subject: "lifecycle", predicate: "trust:subject", object: "subject" },
    ],
    promptVersion: "human-vouch-lifecycle-v1",
  });
}

export async function revokeTrustVouch({
  channelId,
  subjectPubkey,
  targetEventId,
}: {
  channelId: string;
  subjectPubkey: string;
  targetEventId: string;
}): Promise<{ eventId: string; state?: string }> {
  return publishTrustVouchLifecycle({
    channelId,
    subjectPubkey,
    targetEventId,
    action: "revoke",
    reason: "I no longer endorse this vouch.",
  });
}
