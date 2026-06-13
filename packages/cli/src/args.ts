export interface ParsedArgs {
  db: string;
  command: string;
  flags: Map<string, string>;
}

export function parseArgs(args: string[]): ParsedArgs {
  let db = ".ouroboros/ouroboros.db";
  const flags = new Map<string, string>();
  let command: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--db") {
      db = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      flags.set(arg.slice(2), readValue(args, index, arg));
      index += 1;
      continue;
    }
    if (!command) {
      command = arg;
      continue;
    }
    fail(`unexpected argument: ${arg}`);
  }

  if (!command) {
    fail("missing command");
  }

  return { db, command, flags };
}

export function required(args: ParsedArgs, name: string) {
  return flag(args, name) ?? fail(`--${name} is required`);
}

export function flag(args: ParsedArgs, name: string) {
  return args.flags.get(name);
}

function readValue(args: string[], index: number, flagName: string) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    fail(`${flagName} requires a value`);
  }
  return value;
}

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
