import './embed.css';

export function EmbedPage() {
  return <main className="jrc-embed">
    <header><img src="/brand/logo-jrc-2024.png" alt="JRC" width="89" height="60" /><span>Conexões</span></header>
    <section className="embed-card" aria-labelledby="embed-title">
      <h1 id="embed-title">Conexões JRC</h1>
      <p>Consulte o estado e reconecte as caixas autorizadas da sua empresa.</p>
      <p>Para configurar uma conexão, acesse o portal da sua empresa.</p>
      <a className="embed-button" href="/conexoes" target="_blank" rel="noopener noreferrer">Abrir portal JRC</a>
    </section>
  </main>;
}
