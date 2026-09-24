/**
 * Pure CLI argument parsing for the analyst orchestrator.
 *
 * Kept free of any imports so it is trivially unit-testable and so the
 * entrypoint (`src/cli.ts`) stays the only module that touches
 * `process.argv` / `process.env`.
 */

export interface CliOptions {
  /** Required simulation round id (also the dataset directory name). */
  round: string;
  /** Starting capital per analyst. Default 100000. */
  capital: number;
  /** Persona keys to run, or "all" for every persona. Default "all". */
  agents: readonly string[] | "all";
  /** Output directory for datasets. Default "./rounds". */
  out: string;
  /** Max simultaneous analyst subagents. Default 3. */
  maxParallel: number;
  /** When set, run `replicates` consistency copies of this persona. */
  replicateOf?: string;
  /** Number of consistency copies. Default 3. */
  replicates: number;
}

export type ParseCliResult = CliOptions | { help: true };

export class CliArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliArgError";
  }
}

function parseNumber(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new CliArgError(`invalid value for ${flag}: "${raw}" (expected a positive number)`);
  }
  return value;
}

/**
 * Parse argv (without node/script) into `CliOptions`.
 * Throws `CliArgError` on malformed input; returns `{ help: true }` for
 * `--help`.
 */
export function parseCliArgs(argv: readonly string[]): ParseCliResult {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { help: true };
  }

  const opts: CliOptions = {
    round: "",
    capital: 100000,
    agents: "all",
    out: "./rounds",
    maxParallel: 3,
    replicates: 3,
  };

  const valueOf = (flag: string, inline?: string): string => {
    if (inline !== undefined) return inline;
    const index = argv.indexOf(flag);
    if (index === -1) return "";
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliArgError(`missing value for ${flag}`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eqIndex = arg.indexOf("=");
    const flag = eqIndex === -1 ? arg : arg.slice(0, eqIndex);
    const inline = eqIndex === -1 ? undefined : arg.slice(eqIndex + 1);

    switch (flag) {
      case "--round":
        opts.round = valueOf(flag, inline);
        break;
      case "--capital":
        opts.capital = parseNumber(valueOf(flag, inline), flag);
        break;
      case "--agents": {
        const raw = valueOf(flag, inline);
        opts.agents =
          raw === "all"
            ? "all"
            : raw
                .split(",")
                .map((k) => k.trim())
                .filter((k) => k.length > 0);
        if (opts.agents !== "all" && opts.agents.length === 0) {
          throw new CliArgError("--agents requires at least one persona key or 'all'");
        }
        break;
      }
      case "--out":
        opts.out = valueOf(flag, inline);
        break;
      case "--max-parallel":
        opts.maxParallel = Math.floor(parseNumber(valueOf(flag, inline), flag));
        break;
      case "--replicate-of":
        opts.replicateOf = valueOf(flag, inline);
        break;
      case "--replicates":
        opts.replicates = Math.floor(parseNumber(valueOf(flag, inline), flag));
        break;
      case "--help":
      case "-h":
        return { help: true };
      default:
        if (arg.startsWith("--")) {
          throw new CliArgError(`unknown flag: ${arg}`);
        }
        break;
    }
  }

  if (opts.round.length === 0) {
    throw new CliArgError("--round <roundId> is required");
  }
  if (opts.replicateOf !== undefined && opts.replicateOf.length === 0) {
    throw new CliArgError("--replicate-of requires a persona key");
  }

  return opts;
}