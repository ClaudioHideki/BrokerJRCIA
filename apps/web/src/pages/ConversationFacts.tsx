import type { LocalConversationContext } from '@jrc/contracts';
type Props = { context: LocalConversationContext | undefined; organizationId: string; channelId: string; conversationId: string };
export function ConversationFacts({ context, organizationId, channelId, conversationId }: Props) {
  if (!context || context.scope.organizationId !== organizationId || context.scope.channelId !== channelId ||
      context.scope.conversationId !== conversationId) return null;
  return <section className="conversation-facts" aria-label="Dados internos do atendimento">
    <h3>Dados internos do atendimento</h3><p>Estado do fluxo: {context.status === 'RESOLVED' ? 'Resolvido' : 'Em andamento'}</p>
    {context.labels.length > 0 && <><h4>Etiquetas</h4><ul>{context.labels.map(label => <li key={label.id}>{label.name}</li>)}</ul></>}
    {context.attributes.length > 0 && <details><summary>Atributos da conversa</summary><dl>{context.attributes.map(attribute =>
      <div key={attribute.key}><dt>{attribute.name}</dt><dd>{typeof attribute.value === 'boolean' ? attribute.value ? 'Sim' : 'Não' : String(attribute.value)}</dd></div>)}</dl></details>}
    {context.privateNotes.length > 0 && <><h4>Notas internas</h4><p>Estas notas são privadas e não são enviadas ao WhatsApp.</p>
      {context.notesTruncated && <p>Mostrando as 100 notas internas mais recentes desta conversa.</p>}
      <ol>{context.privateNotes.map(note => <li key={note.id}><small><time dateTime={note.createdAt}>{new Date(note.createdAt).toLocaleString('pt-BR')}</time> · Nota privada</small><p>{note.text}</p></li>)}</ol>
    </>}
  </section>;
}
