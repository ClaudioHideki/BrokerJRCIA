import type { NicoTakeoverOperation, NicoTakeoverRequest, NicoTakeoverSnapshot } from '@jrc/contracts';
import type { ChatwootControlPrincipal } from './chatwoot-control-auth.js';

export interface NicoTakeovers {
  attendance(principal: ChatwootControlPrincipal, integrationId: string, remoteConversationId: number): Promise<NicoTakeoverSnapshot>;
  start(principal: ChatwootControlPrincipal, integrationId: string, remoteConversationId: number, input: NicoTakeoverRequest): Promise<NicoTakeoverOperation>;
  get(principal: ChatwootControlPrincipal, integrationId: string, remoteConversationId: number, id: string): Promise<NicoTakeoverOperation>;
  complete(principal: ChatwootControlPrincipal, integrationId: string, remoteConversationId: number, id: string, messageId: number): Promise<NicoTakeoverOperation>;
  cancel(principal: ChatwootControlPrincipal, integrationId: string, remoteConversationId: number,
    input: Pick<NicoTakeoverRequest, 'requestId' | 'fingerprint'>): Promise<NicoTakeoverOperation>;
}
