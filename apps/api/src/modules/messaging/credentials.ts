import { z } from "zod";
import { MetaCloudClient, TypebotClient } from "@jrc/providers";
import type { MessagingChannel } from "./types.js";

const registrySchema = z.record(
  z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  z.strictObject({
    organizationIds: z.array(z.uuid()).min(1).max(1000),
    accessToken: z.string().min(1).max(4096),
    graphVersion: z.string().regex(/^v\d+\.\d+$/),
  }),
);

/** Operational secret registry, never populated from a browser request. */
export function createMetaClientResolver(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
  resolveDynamic?: (
    channel: MessagingChannel,
  ) => Promise<{ accessToken: string; graphVersion: string }>,
) {
  let credentials: z.infer<typeof registrySchema>;
  try {
    const serialized = environment.META_CREDENTIALS_JSON ?? "{}";
    if (Buffer.byteLength(serialized) > 1_048_576) throw new Error();
    credentials = registrySchema.parse(JSON.parse(serialized));
  } catch {
    throw new Error("INVALID_META_CREDENTIAL_REGISTRY");
  }
  return async (channel: MessagingChannel): Promise<MetaCloudClient> => {
    if (
      channel.provider === "BAILEYS" ||
      !channel.phoneNumberId ||
      !channel.wabaId
    )
      throw Object.assign(new Error("META_CHANNEL_NOT_CONFIGURED"), {
        status: 503,
      });
    if (channel.credentialReference.startsWith("meta-db:")) {
      if (!resolveDynamic)
        throw Object.assign(new Error("META_CHANNEL_NOT_CONFIGURED"), {
          status: 503,
        });
      const credential = await resolveDynamic(channel);
      return new MetaCloudClient({
        ...credential,
        phoneNumberId: channel.phoneNumberId,
        wabaId: channel.wabaId,
      });
    }
    const credential = Object.hasOwn(credentials, channel.credentialReference)
      ? credentials[channel.credentialReference]
      : undefined;
    if (
      !credential ||
      !credential.organizationIds.includes(channel.organizationId)
    )
      throw Object.assign(new Error("META_CHANNEL_NOT_CONFIGURED"), {
        status: 503,
      });
    return new MetaCloudClient({
      ...credential,
      phoneNumberId: channel.phoneNumberId,
      wabaId: channel.wabaId,
    });
  };
}

const originsSchema = z.record(
  z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  z.strictObject({
    origin: z.string().url().max(2048),
    accessToken: z.string().min(1).max(4096).optional(),
    organizationIds: z.array(z.uuid()).min(1).max(1000),
  }),
);

export function createTypebotClientResolver(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
) {
  let origins: z.infer<typeof originsSchema>;
  try {
    const serialized = environment.TYPEBOT_ORIGINS_JSON ?? "{}";
    if (Buffer.byteLength(serialized) > 1_048_576) throw new Error();
    origins = originsSchema.parse(JSON.parse(serialized));
  } catch {
    throw new Error("INVALID_TYPEBOT_ORIGIN_REGISTRY");
  }
  return async (
    reference: string,
    organizationId: string,
  ): Promise<TypebotClient> => {
    const destination = Object.hasOwn(origins, reference)
      ? origins[reference]
      : undefined;
    if (!destination || !destination.organizationIds.includes(organizationId)) {
      throw new Error("TYPEBOT_NOT_CONFIGURED");
    }
    return new TypebotClient({
      origin: destination.origin,
      allowedOrigins: [destination.origin],
      ...(destination.accessToken === undefined
        ? {}
        : { accessToken: destination.accessToken }),
    });
  };
}
