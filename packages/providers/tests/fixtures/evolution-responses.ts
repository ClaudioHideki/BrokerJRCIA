export const evolutionFixtures = {
  created: {
    instance: {
      instanceName: 'jrc_018f17dd-c346-7fb0-9a3c-97f9cb3ba243',
      instanceId: '48ea9957-d168-4b3f-810c-3cc648498a3b',
      integration: 'WHATSAPP-BAILEYS',
      status: 'close',
      ignoredByJrc: 'must-not-escape',
    },
    hash: 'upstream-instance-token-must-not-escape',
    ignoredTopLevel: true,
  },
  fetched: [
    {
      id: '48ea9957-d168-4b3f-810c-3cc648498a3b',
      name: 'jrc_018f17dd-c346-7fb0-9a3c-97f9cb3ba243',
      connectionStatus: 'open',
      token: 'upstream-instance-token-must-not-escape',
      ownerJid: '5511999999999@s.whatsapp.net',
      ignoredByJrc: 'must-not-escape',
    },
  ],
  qrCode: {
    count: 1,
    base64: 'YWJj',
    code: 'raw-qr-must-not-escape',
    ignoredByJrc: 'must-not-escape',
  },
  pairingCode: {
    count: 1,
    pairingCode: '82716490',
    base64: 'qr-must-not-win-when-pairing-is-returned',
    ignoredByJrc: 'must-not-escape',
  },
  connected: {
    instance: {
      instanceName: 'jrc_018f17dd-c346-7fb0-9a3c-97f9cb3ba243',
      state: 'open',
    },
  },
  connecting: {
    instance: {
      instanceName: 'jrc_018f17dd-c346-7fb0-9a3c-97f9cb3ba243',
      state: 'connecting',
    },
  },
  statusOpen: {
    instance: {
      instanceName: 'jrc_018f17dd-c346-7fb0-9a3c-97f9cb3ba243',
      state: 'open',
      ignoredByJrc: 'must-not-escape',
    },
  },
  mutationSuccess: {
    status: 'SUCCESS',
    error: false,
    response: { message: 'internal upstream wording must not escape' },
  },
} as const;
