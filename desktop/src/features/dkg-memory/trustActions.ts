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

async function projectTrustSource(
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
  const body = JSON.stringify(proposal);
  const deadline = Date.now() + 120_000;
  do {
    const result = await postTrustMemoryProposal(body);
    if (memoryProposalProgress(result.state) !== "processing") {
      return { eventId: source.id, state: result.state };
    }
    await new Promise((resolve) => window.setTimeout(resolve, 2_000));
  } while (Date.now() < deadline);
  return { eventId: source.id, state: "processing" };
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
  const displayName = subjectName.trim().slice(0, 500) || subject.slice(0, 12);
  const normalizedNote = note.trim();
  if (!HEX_PUBKEY.test(subject)) throw new Error("Invalid vouch subject.");
  if (!normalizedNote || normalizedNote.length > 1_000) {
    throw new Error("A vouch explanation must contain 1–1,000 characters.");
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
  await relayClient.publishEvent(
    vouch,
    "The signed vouch timed out before the relay confirmed it.",
    "The relay could not publish the signed vouch.",
  );

  const issuer = vouch.pubkey.toLowerCase();
  const result = await projectTrustSource(channelId, vouch, {
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
  const normalizedReason = reason.trim();
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
  if (!normalizedReason || normalizedReason.length > 1_000) {
    throw new Error("A lifecycle reason must contain 1–1,000 characters.");
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
  await relayClient.publishEvent(
    lifecycle,
    "The signed trust update timed out before the relay confirmed it.",
    "The relay could not publish the signed trust update.",
  );
  const issuer = lifecycle.pubkey.toLowerCase();
  const status = action === "revoke" ? "revoked" : "superseded";
  return projectTrustSource(channelId, lifecycle, {
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
