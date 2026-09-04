export function requiredEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = String(env[name] ?? "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
