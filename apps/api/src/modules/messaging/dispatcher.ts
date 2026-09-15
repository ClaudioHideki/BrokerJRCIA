import type {
  MetaCloudClient,
  MetaMessageTemplate,
  MetaTemplateSendInput,
} from "@jrc/providers";
import type {
  CompleteSendOutcome,
  OutboxClaim,
  TemplateMessageContent,
} from "./types.js";
import { MediaError } from "@jrc/providers";

export interface DispatchPorts {
  /** Must open and close its own short transaction, rechecking lease and policy. */
  validate(claim: OutboxClaim): Promise<boolean>;
  resolveClient(
    claim: OutboxClaim,
  ): Promise<
    Pick<MetaCloudClient, "sendText" | "sendTemplate" | "listTemplates">
  >;
  /** Resolve bytes and upload before the final lease check; returned callback performs only the send. */
  prepareMedia?(
    claim: OutboxClaim,
  ): Promise<() => Promise<{ upstreamMessageId: string }>>;
  /** A failure here leaves the lease to expire as UNKNOWN; never resend blindly. */
  complete(claim: OutboxClaim, outcome: CompleteSendOutcome): Promise<void>;
}

type TemplatePreflight =
  | { accepted: true; input: MetaTemplateSendInput }
  | { accepted: false; canonicalErrorCode: string };
export type TemplateComponentValidation = number | "VARIABLE_MISMATCH" | null;
type BodyPositions = number[] | "UNSUPPORTED" | "VARIABLE_MISMATCH";
const MAX_TEMPLATE_VARIABLES = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function includesTemplateVariable(value: unknown): boolean {
  if (typeof value === "string") return /\{\{[^{}]+\}\}/u.test(value);
  if (Array.isArray(value)) return value.some(includesTemplateVariable);
  return isRecord(value) && Object.values(value).some(includesTemplateVariable);
}

function readBodyPositions(text: string): BodyPositions {
  const positions = new Set<number>();
  const markers = [...text.matchAll(/\{\{([^{}]*)\}\}/gu)];
  const withoutMarkers = text.replace(/\{\{[^{}]*\}\}/gu, "");
  if (withoutMarkers.includes("{{") || withoutMarkers.includes("}}"))
    return "UNSUPPORTED";
  for (const marker of markers) {
    const positionText = marker[1];
    if (positionText === undefined || !/^\s*[1-9]\d*\s*$/u.test(positionText)) {
      return "UNSUPPORTED";
    }
    const position = Number(positionText.trim());
    if (!Number.isSafeInteger(position) || position <= 0)
      return "VARIABLE_MISMATCH";
    positions.add(position);
  }
  const ordered = [...positions].sort((left, right) => left - right);
  if (ordered.some((position, index) => position !== index + 1)) {
    return "VARIABLE_MISMATCH";
  }
  if (ordered.length > MAX_TEMPLATE_VARIABLES) return "VARIABLE_MISMATCH";
  return ordered;
}

export function inspectTemplateComponents(
  template: MetaMessageTemplate,
): TemplateComponentValidation {
  let bodyPositions: BodyPositions = [];
  let observedBody = false;

  for (const component of template.components) {
    if (!isRecord(component) || typeof component.type !== "string") return null;
    const type = component.type.toUpperCase();
    switch (type) {
      case "BODY": {
        if (observedBody || typeof component.text !== "string") return null;
        observedBody = true;
        bodyPositions = readBodyPositions(component.text);
        if (bodyPositions === "UNSUPPORTED") return null;
        if (bodyPositions === "VARIABLE_MISMATCH") return bodyPositions;
        break;
      }
      case "HEADER": {
        if (component.format !== "TEXT" || includesTemplateVariable(component))
          return null;
        break;
      }
      case "FOOTER":
      case "BUTTONS": {
        if (includesTemplateVariable(component)) return null;
        break;
      }
      default:
        return null;
    }
  }

  return observedBody ? bodyPositions.length : null;
}

function preflightTemplate(
  content: TemplateMessageContent,
  templates: readonly MetaMessageTemplate[],
): TemplatePreflight {
  const matches = templates.filter(
    (template) =>
      template.name === content.name && template.language === content.language,
  );
  if (matches.length !== 1 || matches[0]?.status !== "APPROVED") {
    return {
      accepted: false,
      canonicalErrorCode: "META_TEMPLATE_NOT_APPROVED",
    };
  }

  const variableCount = inspectTemplateComponents(matches[0]);
  if (variableCount === null) {
    return {
      accepted: false,
      canonicalErrorCode: "META_TEMPLATE_UNSUPPORTED_COMPONENTS",
    };
  }
  if (variableCount === "VARIABLE_MISMATCH") {
    return {
      accepted: false,
      canonicalErrorCode: "META_TEMPLATE_VARIABLE_MISMATCH",
    };
  }
  if (
    !Array.isArray(content.variables) ||
    content.variables.length !== variableCount ||
    content.variables.some((value) => typeof value !== "string")
  ) {
    return {
      accepted: false,
      canonicalErrorCode: "META_TEMPLATE_VARIABLE_MISMATCH",
    };
  }

  return {
    accepted: true,
    input: {
      name: content.name,
      language: content.language,
      ...(content.variables.length === 0
        ? {}
        : {
            components: [
              {
                type: "body",
                parameters: content.variables.map((text) => ({
                  type: "text",
                  text,
                })),
              },
            ],
          }),
    },
  };
}

function providerOutcome(error: unknown, qr: boolean): CompleteSendOutcome {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : null;
  if (code === "QR_RATE_LIMITED")
    return { state: "FAILED", canonicalErrorCode: code, retrySafe: true };
  return code === "META_REQUEST_REJECTED" ||
    code === "INVALID_META_INPUT" ||
    code === "QR_REQUEST_REJECTED" ||
    code === "INVALID_QR_INPUT"
    ? { state: "FAILED", canonicalErrorCode: code, retrySafe: false }
    : {
        state: "UNKNOWN",
        canonicalErrorCode: qr ? "QR_SEND_UNKNOWN" : "META_SEND_UNKNOWN",
      };
}

export async function dispatchClaim(
  claim: OutboxClaim,
  ports: DispatchPorts,
): Promise<void> {
  const qr = claim.channel.provider === "BAILEYS";
  if (qr && claim.message.content.type === "TEMPLATE") {
    await ports.complete(claim, {
      state: "FAILED",
      canonicalErrorCode: "CHANNEL_CAPABILITY_UNSUPPORTED",
      retrySafe: false,
    });
    return;
  }
  let client: Awaited<ReturnType<DispatchPorts["resolveClient"]>>;
  try {
    client = await ports.resolveClient(claim);
  } catch (error) {
    // No provider POST occurred: persist a safe terminal failure instead of leaking a lease.
    const disconnected =
      qr &&
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "QR_CHANNEL_DISCONNECTED";
    await ports.complete(claim, {
      state: "FAILED",
      canonicalErrorCode: disconnected
        ? "QR_CHANNEL_DISCONNECTED"
        : qr
          ? "QR_CHANNEL_UNAVAILABLE"
          : "META_CREDENTIAL_UNAVAILABLE",
      retrySafe: disconnected,
    });
    return;
  }
  const content = claim.message.content;
  let templateInput: MetaTemplateSendInput | null = null;
  let sendMedia: (() => Promise<{ upstreamMessageId: string }>) | undefined;
  if (content.type === "MEDIA") {
    try {
      if (!ports.prepareMedia) throw new MediaError("MEDIA_NOT_CONFIGURED");
      sendMedia = await ports.prepareMedia(claim);
    } catch (error) {
      await ports.complete(claim, {
        state: "FAILED",
        canonicalErrorCode:
          error instanceof MediaError ? error.code : "MEDIA_PREPARATION_FAILED",
        retrySafe: !(error instanceof MediaError) || error.retrySafe,
      });
      return;
    }
  }

  if (content.type === "TEMPLATE") {
    let templates: MetaMessageTemplate[];
    try {
      templates = await client.listTemplates();
    } catch {
      await ports.complete(claim, {
        state: "FAILED",
        canonicalErrorCode: "META_TEMPLATE_LOOKUP_FAILED",
        retrySafe: true,
      });
      return;
    }

    const preflight = preflightTemplate(content, templates);
    if (!preflight.accepted) {
      await ports.complete(claim, {
        state: "FAILED",
        canonicalErrorCode: preflight.canonicalErrorCode,
        retrySafe: false,
      });
      return;
    }
    templateInput = preflight.input;
  }

  // For templates, this check intentionally occurs after the provider lookup
  // so policy and lease state are fresh immediately before the send POST.
  if (!(await ports.validate(claim))) return;

  let outcome: CompleteSendOutcome;
  try {
    const accepted =
      content.type === "MEDIA"
        ? await sendMedia!()
        : content.type === "TEXT"
          ? await client.sendText(claim.contact.externalId, content.text)
          : await client.sendTemplate(
              claim.contact.externalId,
              templateInput as MetaTemplateSendInput,
            );
    outcome = { state: "SENT", upstreamMessageId: accepted.upstreamMessageId };
  } catch (error) {
    outcome = providerOutcome(error, qr);
  }
  // Intentionally outside catch: a storage error is not a provider rejection.
  await ports.complete(claim, outcome);
}
