export function assertNoDuplicateJsonObjectKeys(
  content: string,
  source: string,
  limits: { maxNodes: number; maxDepth: number },
  description = "action event",
): void {
  let index = 0;
  let nodes = 0;
  const numberPattern = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

  const fail = (): never => {
    throw new Error(`invalid ${description} JSON: ${source}`);
  };
  const skipWhitespace = (): void => {
    while (index < content.length && /[\t\n\r ]/.test(content[index]!)) index += 1;
  };
  const parseString = (): string => {
    if (content[index] !== '"') fail();
    const start = index;
    index += 1;
    while (index < content.length) {
      const character = content[index]!;
      index += 1;
      if (character === '"') {
        try {
          const value = JSON.parse(content.slice(start, index)) as unknown;
          if (typeof value !== "string") fail();
          return value as string;
        } catch {
          fail();
        }
      }
      if (character === "\\") {
        if (index >= content.length) fail();
        index += 1;
      } else if (character.charCodeAt(0) < 0x20) {
        fail();
      }
    }
    return fail();
  };
  const parseValue = (depth: number): void => {
    nodes += 1;
    if (nodes > limits.maxNodes || depth > limits.maxDepth) {
      throw new Error(`${description} JSON exceeds canonical complexity limits: ${source}`);
    }
    skipWhitespace();
    const character = content[index];
    if (character === "{") {
      index += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (content[index] === "}") {
        index += 1;
        return;
      }
      while (index < content.length) {
        const key = parseString();
        if (keys.has(key)) {
          throw new Error(`${description} JSON contains a duplicate object key: ${source}`);
        }
        keys.add(key);
        skipWhitespace();
        if (content[index] !== ":") fail();
        index += 1;
        parseValue(depth + 1);
        skipWhitespace();
        if (content[index] === "}") {
          index += 1;
          return;
        }
        if (content[index] !== ",") fail();
        index += 1;
        skipWhitespace();
      }
      fail();
    }
    if (character === "[") {
      index += 1;
      skipWhitespace();
      if (content[index] === "]") {
        index += 1;
        return;
      }
      while (index < content.length) {
        parseValue(depth + 1);
        skipWhitespace();
        if (content[index] === "]") {
          index += 1;
          return;
        }
        if (content[index] !== ",") fail();
        index += 1;
      }
      fail();
    }
    if (character === '"') {
      parseString();
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (content.startsWith(literal, index)) {
        index += literal.length;
        return;
      }
    }
    numberPattern.lastIndex = index;
    const match = numberPattern.exec(content);
    if (!match) fail();
    index = numberPattern.lastIndex;
  };

  parseValue(0);
  skipWhitespace();
  if (index !== content.length) fail();
}
