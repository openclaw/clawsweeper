export interface Args {
  _: string[];
  [key: string]: string | boolean | string[];
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === "--") continue;
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }
    const key = arg.slice(2).replaceAll("-", "_");
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

export function requiredCliValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function stringArg(
  value: string | boolean | string[] | undefined,
  fallback: string,
): string {
  return typeof value === "string" ? value : fallback;
}

export function numberArg(
  value: string | boolean | string[] | undefined,
  fallback: number,
): number {
  if (typeof value !== "string") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function optionalNumberArg(
  value: string | boolean | string[] | undefined,
): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function boolArg(value: string | boolean | string[] | undefined): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  return value === "1" || value === "true" || value === "yes";
}

export function argString(args: Args, key: string, fallback: string): string {
  const value = args[key];
  return typeof value === "string" && value.length ? value : fallback;
}

export function argNumber(args: Args, key: string, fallback: number): number {
  const value = Number(argString(args, key, String(fallback)));
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`Invalid --${key.replaceAll("_", "-")}`);
  return value;
}

export function itemNumbersArg(
  itemNumbers: string | boolean | string[] | undefined,
  itemNumber: string | boolean | string[] | undefined,
): number[] {
  const numbers = new Set<number>();
  const add = (value: string): void => {
    for (const part of value.split(",")) {
      const parsed = Number(part.trim());
      if (Number.isInteger(parsed) && parsed > 0) numbers.add(parsed);
    }
  };
  if (typeof itemNumbers === "string") add(itemNumbers);
  if (typeof itemNumber === "string") add(itemNumber);
  return [...numbers].sort((left, right) => left - right);
}
