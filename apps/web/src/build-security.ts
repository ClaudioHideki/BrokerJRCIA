export function assertNoViteClientEnvironment(
  environment: Record<string, string | undefined>,
): void {
  const exposedNames = Object.keys(environment)
    .filter((name) => name.startsWith('VITE_'))
    .sort();
  if (exposedNames.length > 0) {
    throw new Error(
      `Client-exposed Vite environment variable is forbidden: ${exposedNames[0]}`,
    );
  }
}
