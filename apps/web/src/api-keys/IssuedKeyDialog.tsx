import { useEffect, useRef, useState } from 'react';

export function IssuedKeyDialog({ secret, onClose }: { secret: string; onClose(): void }) {
  const dialog = useRef<HTMLElement>(null);
  const secretValue = useRef<HTMLElement>(null);
  const copyButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [copyFeedback, setCopyFeedback] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    copyButton.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const first = secretValue.current;
      const last = closeButton.current;
      const active = document.activeElement;
      if (!first || !last) return;
      if (event.shiftKey && (active === first || !dialog.current?.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.current?.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      const previousFocusIsDisabled = previousFocus instanceof HTMLButtonElement && previousFocus.disabled;
      if (previousFocus?.isConnected && !previousFocusIsDisabled) {
        previousFocus.focus();
      } else {
        document.getElementById('api-key-name')?.focus();
      }
    };
  }, [onClose]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopyFeedback('copied');
    } catch {
      setCopyFeedback('failed');
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section ref={dialog} className="secret-dialog" role="dialog" aria-modal="true" aria-labelledby="issued-key-title">
        <p className="eyebrow">Revelação única</p>
        <h2 id="issued-key-title">Chave emitida</h2>
        <p>Copie agora. A JRC não poderá mostrar este segredo novamente.</p>
        <code ref={secretValue} className="secret-value" tabIndex={0} aria-label="Chave secreta emitida">{secret}</code>
        <div className="dialog-actions">
          <button ref={copyButton} className="button button--primary" type="button" onClick={() => void copy()}>Copiar chave</button>
          <button ref={closeButton} className="button button--ghost" type="button" onClick={onClose}>Fechar</button>
        </div>
        <p aria-live="polite">
          {copyFeedback === 'copied' ? 'Chave copiada.' : ''}
          {copyFeedback === 'failed' ? 'Não foi possível copiar. Selecione a chave e copie manualmente.' : ''}
        </p>
      </section>
    </div>
  );
}
