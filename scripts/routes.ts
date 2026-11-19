import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSqlForCommand,
  CliValidationError,
  formatRoutesTable,
  parseCliArgs,
  type RouteRow,
} from "./routes-core.ts";

const DB_NAME = "pages";

export interface D1StatementResult<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
}

export type D1Executor = <T = Record<string, unknown>>(
  sql: string,
  remote: boolean,
) => T[];

function getProjectRoot(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), "..");
}

function getHelpText(): string {
  return [
    "Uso: npm run route -- <comando> [opções]",
    "",
    "Comandos:",
    "  add <slug> --type <redirect|page> --target <url|pasta> [--status 301|302] [--track-hits] [--inactive] [--skip-asset-check] [--remote]",
    "  list [--json] [--remote]",
    "  enable <slug> [--remote]",
    "  disable <slug> [--remote]",
    "  delete <slug> [--remote]",
    "",
    "Opções globais:",
    "  --local   Executa no banco D1 local (padrão)",
    "  --remote  Executa no banco D1 remoto",
    "  -h, --help  Exibe esta ajuda",
  ].join("\n");
}

export function executeD1WithWrangler<T = Record<string, unknown>>(
  sql: string,
  remote: boolean,
  projectRoot: string = getProjectRoot(),
): T[] {
  const localWrangler = path.resolve(
    projectRoot,
    "node_modules",
    ".bin",
    "wrangler",
  );
  const command = existsSync(localWrangler) ? localWrangler : "wrangler";
  const args = [
    "d1",
    "execute",
    DB_NAME,
    remote ? "--remote" : "--local",
    "--json",
    "--command",
    sql,
  ];

  let stdout: string;
  try {
    stdout = execFileSync(command, args, {
      cwd: projectRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH ?? "/tmp",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const err = error as { stderr?: string; stdout?: string; message: string };
    const detail = err.stderr?.trim() || err.stdout?.trim() || err.message;
    throw new Error(`Falha ao executar wrangler d1 execute: ${detail}`);
  }

  const parsed = JSON.parse(stdout) as D1StatementResult<T>[];
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed[0].success) {
    throw new Error(`Resposta inesperada do D1: ${stdout}`);
  }

  return parsed[0].results ?? [];
}

export function runCli(
  argv: string[],
  options: {
    projectRoot?: string;
    executor?: D1Executor;
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
  } = {},
): number {
  const projectRoot = options.projectRoot ?? getProjectRoot();
  const executor: D1Executor =
    options.executor ??
    (<T = Record<string, unknown>>(sql: string, remote: boolean) =>
      executeD1WithWrangler<T>(sql, remote, projectRoot));
  const stdout = options.stdout ?? ((text: string) => console.log(text));
  const stderr = options.stderr ?? ((text: string) => console.error(text));

  try {
    const command = parseCliArgs(argv, projectRoot);

    if (command.action === "help") {
      stdout(getHelpText());
      return 0;
    }

    const sql = buildSqlForCommand(command);

    if (command.action === "list") {
      const rows = executor<RouteRow>(sql, command.remote);
      stdout(command.json ? JSON.stringify(rows, null, 2) : formatRoutesTable(rows));
      return 0;
    }

    if (command.action === "add") {
      executor(sql, command.remote);
      const envLabel = command.remote ? "remote" : "local";
      stdout(
        `Rota "${command.slug}" salva (${command.type} -> ${command.target}, status=${command.statusCode}, active=${command.active}, track_hits=${command.trackHits}) [${envLabel}].`,
      );
      return 0;
    }

    const affected = executor<{ slug: string }>(sql, command.remote);
    if (affected.length === 0) {
      stderr(`Erro: rota "${command.slug}" não encontrada.`);
      return 1;
    }

    const envLabel = command.remote ? "remote" : "local";
    const actionLabel =
      command.action === "enable"
        ? "ativada"
        : command.action === "disable"
          ? "desativada"
          : "removida";
    stdout(`Rota "${command.slug}" ${actionLabel} [${envLabel}].`);
    return 0;
  } catch (error) {
    if (error instanceof CliValidationError) {
      stderr(`Erro de validação: ${error.message}`);
      return 1;
    }

    const message = error instanceof Error ? error.message : String(error);
    stderr(`Erro: ${message}`);
    return 1;
  }
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const exitCode = runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
