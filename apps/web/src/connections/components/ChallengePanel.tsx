import { useEffect, useMemo } from 'react';

import type { ConnectionAction } from '@jrc/contracts';

import { safeQrPngDataUrl } from '../safe-png.js';

export function ChallengePanel({
  action,
  onExpire,
}: {
  action: ConnectionAction;
  onExpire(): void;
}) {
  const expiresAt = 'expiresAt' in action ? Date.parse(action.expiresAt) : null;
  const expired = expiresAt !== null && Number.isFinite(expiresAt) && expiresAt <= Date.now();
  useEffect(() => {
    if (expiresAt === null || !Number.isFinite(expiresAt)) return undefined;
    if (expired) {
      onExpire();
      return undefined;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) {
        onExpire();
        return;
      }
      timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647));
    };
    schedule();
    return () => { if (timer !== undefined) clearTimeout(timer); };
  }, [expired, expiresAt, onExpire]);

  const qr = useMemo(() => {
    if (action.type !== 'QR_CODE') return null;
    try {
      return { src: safeQrPngDataUrl(action) } as const;
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'QR Code inválido.' } as const;
    }
  }, [action]);

  if (expired) return null;

  if (action.type === 'QR_CODE') {
    if (qr && 'error' in qr) return <div className="notice notice--error" role="alert">{qr.error}</div>;
    return (
      <section className="challenge-card" aria-labelledby="qr-title">
        <h2 id="qr-title">Leia o QR Code</h2>
        <p>No WhatsApp do celular, abra Aparelhos conectados → Conectar um aparelho e leia este QR Code antes que expire.</p>
        <img src={qr?.src} alt="QR Code para conectar o WhatsApp" width="280" height="280" />
      </section>
    );
  }
  if (action.type === 'PAIRING_CODE') {
    return (
      <section className="challenge-card" aria-labelledby="pairing-title">
        <h2 id="pairing-title">Código de pareamento</h2>
        <code className="pairing-code">{action.code}</code>
        <p>No WhatsApp do celular, abra Aparelhos conectados → Conectar um aparelho → Conectar com número de telefone. Digite este código antes que expire. Ele não é um código de SMS nem uma chave de API.</p>
      </section>
    );
  }
  if (action.type === 'REDIRECT' || action.type === 'EMBEDDED_SIGNUP') {
    return <div className="notice">Este fluxo ainda não está disponível neste incremento.</div>;
  }
  const messages = {
    ALREADY_CONNECTED: 'A conexão já está ativa.',
    CONNECTION_PENDING: 'A operação de conexão está em andamento. O desafio anterior não pode ser recuperado.',
    NO_USER_ACTION_REQUIRED: 'Nenhuma ação manual é necessária. Acompanhando o status.',
  } as const;
  return <div className="notice" role="status">{messages[action.reason]}</div>;
}
