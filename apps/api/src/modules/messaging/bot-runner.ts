import type { TypebotChatResult } from '@jrc/providers';

export interface BotTurnPorts {
  startChat(publicId: string, text: string): Promise<TypebotChatResult>;
  continueChat(sessionId: string, text: string): Promise<TypebotChatResult>;
  /** Atomically checks bot ownership/mode/lease, stores session and enqueues replies. */
  complete(result: { sessionId: string; texts: string[] }): Promise<void>;
  fail(
    code: 'TYPEBOT_TURN_FAILED' | 'TYPEBOT_TURN_UNKNOWN' | 'TYPEBOT_UNSUPPORTED_OUTPUT',
    uncertain: boolean,
  ): Promise<void>;
}

const DEFINITE_FAILURE_CODES = new Set([
  'INVALID_ARGUMENT',
  'INVALID_CONFIGURATION',
  'UPSTREAM_ERROR',
]);

function isDefiniteFailure(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
    && DEFINITE_FAILURE_CODES.has(error.code);
}

export async function runBotTurn(turn: { publicId: string; sessionId: string | null; text: string }, ports: BotTurnPorts): Promise<void> {
  let result: TypebotChatResult;
  try {
    if (turn.sessionId === null) result = await ports.startChat(turn.publicId, turn.text);
    else {
      try { result = await ports.continueChat(turn.sessionId, turn.text); }
      catch (error) {
        if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'SESSION_EXPIRED') throw error;
        result = await ports.startChat(turn.publicId, turn.text);
      }
    }
  } catch (error) {
    const definite = isDefiniteFailure(error);
    await ports.fail(definite ? 'TYPEBOT_TURN_FAILED' : 'TYPEBOT_TURN_UNKNOWN', !definite);
    return;
  }
  if (result.incompatibilities.length > 0 || result.texts.length > 100 || result.texts.some(text => text.length === 0 || text.length > 4096)) {
    await ports.fail('TYPEBOT_UNSUPPORTED_OUTPUT', true);
    return;
  }
  // A persistence failure must leave the running lease uncertain, not call the bot again.
  await ports.complete({ sessionId: result.sessionId, texts: result.texts });
}
