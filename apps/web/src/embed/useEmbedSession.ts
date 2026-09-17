import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { EmbedPolicySchema } from '@jrc/contracts';
import { EmbedSessionClient } from './session-client.js';
import { isAllowedContextEvent, parseAppContext } from './context.js';

export function useEmbedSession(embedId: string) {
  const client = useMemo(() => new EmbedSessionClient(embedId), [embedId]);
  const state = useSyncExternalStore(client.subscribe, client.snapshot);
  const [origin, setOrigin] = useState(''), [approvalLink, setApprovalLink] = useState<string | null>(null);
  const [popupBlocked, setPopupBlocked] = useState(false);
  useEffect(() => {
    const abort = new AbortController(); let current = true;
    void fetch(`/v1/embed/apps/${embedId}/policy`, { cache: 'no-store', credentials: 'omit', signal: abort.signal }).then(async response => {
      if (!response.ok) throw new Error('UNAVAILABLE');
      const policy = EmbedPolicySchema.parse(await response.json());
      if (current) setOrigin(policy.origin);
    }).catch(() => { if (current) client.stop('UNAVAILABLE'); });
    const leave = () => client.stop();
    const visible = () => { if (document.visibilityState === 'visible') void client.refresh(); };
    window.addEventListener('pagehide', leave); document.addEventListener('visibilitychange', visible);
    return () => { current = false; abort.abort(); client.stop(); window.removeEventListener('pagehide', leave); document.removeEventListener('visibilitychange', visible); };
  }, [client, embedId]);
  useEffect(() => {
    if (!origin) return;
    const receive = (event: MessageEvent) => {
      if (!isAllowedContextEvent({ origin: event.origin, sourceIsParent: event.source === window.parent && window.parent !== window }, origin)) return;
      client.context(parseAppContext(event.data));
    };
    window.addEventListener('message', receive);
    // Ask only for context, with an exact target origin. QR and tokens never leave this frame.
    const requestContext = () => { if (window.parent !== window) window.parent.postMessage('chatwoot-dashboard-app:fetch-info', origin); };
    requestContext(); const poll = setInterval(requestContext, 5000);
    return () => { clearInterval(poll); window.removeEventListener('message', receive); };
  }, [client, origin]);
  const begin = useCallback(async () => {
    if (!origin || ['STARTING', 'WAITING'].includes(client.snapshot().status)) return;
    setApprovalLink(null); setPopupBlocked(false);
    // Open synchronously within the click; never navigate or open a popup on mount.
    let popup: Window | null = null;
    try { popup = window.open('about:blank', '_blank', 'popup,width=640,height=780'); if (popup) popup.opener = null; }
    catch { /* A sandboxed or policy-blocked popup uses the explicit portal link. */ }
    const link = await client.begin();
    if (!link) { popup?.close(); return; }
    setApprovalLink(link);
    if (!popup || popup.closed) setPopupBlocked(true);
    else { try { popup.location.replace(new URL(link, window.location.origin).href); } catch { setPopupBlocked(true); } }
  }, [client, origin]);
  return { state, client, begin, ready: Boolean(origin), approvalLink, popupBlocked };
}
