export function connectionAccountLabel(name: string): string {
  return name.replace(/\bEvolution(?:\s+API)?\b|\bBaileys\b/gi, "JRC QR Code");
}
export function connectionTypeLabel(provider: string): string {
  return provider === "META"
    ? "WhatsApp Oficial"
    : "WhatsApp Business por QR Code";
}
