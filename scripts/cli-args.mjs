import { parseArgs } from "node:util";

// These CLIs ignore standalone `--` but require separate, nonempty string values.
export function parseCliArgs(argv, options) {
  const flags = new Map(
    Object.entries(options).flatMap(([name, option]) => [
      [`--${name}`, option],
      ...(option.short ? [[`-${option.short}`, option]] : []),
    ]),
  );
  const normalized = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    const option = flags.get(arg);
    if (!option) throw new Error(`unknown option: ${arg}; use --help for usage`);
    if (option.type === "boolean") normalized.push(arg);
    else {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      normalized.push(`${arg}=${value}`);
    }
  }
  return parseArgs({ args: normalized, options }).values;
}
