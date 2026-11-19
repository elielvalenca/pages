import { existsSync } from "node:fs";
import path from "node:path";

export type CliCommand =
  | {
      action: "help";
    }
  | {
      action: "add";
      slug: string;
      type: "redirect" | "page";
      target: string;
      statusCode: 301 | 302;
      active: 0 | 1;
      trackHits: 0 | 1;
      skipAssetCheck: boolean;
      remote: boolean;
    }
  | {
      action: "list";
      json: boolean;
      remote: boolean;
    }
  | {
      action: "enable" | "disable" | "delete";
      slug: string;
      remote: boolean;
    };

export interface RouteRow {
  slug: string;
  type: "redirect" | "page";
  target: string;
  status_code: number;
  active: number;
  track_hits: number;
  hits: number;
  last_hit_at: string | null;
  created_at?: string;
  updated_at?: string;
}

export class CliValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliValidationError";
  }
}

const RESERVED_SLUGS = new Set(["_pages", "_assets", "404.html"]);
const SAFE_IDENTIFIER_RE = /^[a-zA-Z0-9._-]+$/;

export function escapeSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function validateSlug(rawSlug: string | undefined): string {
  if (!rawSlug || rawSlug.trim() === "") {
    throw new CliValidationError("Slug obrigatório não informado.");
  }

  const slug = rawSlug.trim();
  if (slug.includes("/") || slug.includes("\\")) {
    throw new CliValidationError(
      `Slug inválido "${slug}": não informe barras iniciais ou múltiplas camadas.`,
    );
  }

  if (RESERVED_SLUGS.has(slug) || slug.startsWith("_pages") || slug.startsWith("_assets")) {
    throw new CliValidationError(
      `Slug reservado "${slug}": não pode colidir com _pages, _assets ou 404.html.`,
    );
  }

  if (slug === "." || slug === ".." || !SAFE_IDENTIFIER_RE.test(slug)) {
    throw new CliValidationError(
      `Slug inválido "${slug}": use apenas letras, números, ".", "_" ou "-".`,
    );
  }

  return slug;
}

export function validateTarget(
  type: "redirect" | "page",
  rawTarget: string | undefined,
  projectRoot: string,
  skipAssetCheck: boolean,
): string {
  if (!rawTarget || rawTarget.trim() === "") {
    throw new CliValidationError("Target obrigatório não informado (--target).");
  }

  const target = rawTarget.trim();

  if (type === "redirect") {
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      throw new CliValidationError(
        `Target inválido para redirect "${target}": informe uma URL completa (http:// ou https://).`,
      );
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new CliValidationError(
        `Protocolo inválido para redirect "${target}": use http:// ou https://.`,
      );
    }

    return target;
  }

  if (target === "." || target === ".." || !SAFE_IDENTIFIER_RE.test(target)) {
    throw new CliValidationError(
      `Target inválido para page "${target}": informe apenas o nome da pasta em public/_pages/.`,
    );
  }

  if (!skipAssetCheck) {
    const expectedIndex = path.resolve(
      projectRoot,
      "public",
      "_pages",
      target,
      "index.html",
    );
    if (!existsSync(expectedIndex)) {
      throw new CliValidationError(
        `Página estática não encontrada: esperado arquivo ${expectedIndex}. Use --skip-asset-check para ignorar esta verificação.`,
      );
    }
  }

  return target;
}

function readOptionValue(
  args: string[],
  index: number,
  flag: string,
): { value: string; nextIndex: number } {
  const token = args[index];
  const eqIdx = token.indexOf("=");
  if (eqIdx !== -1) {
    return { value: token.slice(eqIdx + 1), nextIndex: index };
  }

  const nextValue = args[index + 1];
  if (nextValue === undefined || nextValue.startsWith("--")) {
    throw new CliValidationError(`A flag ${flag} exige um valor.`);
  }

  return { value: nextValue, nextIndex: index + 1 };
}

export function parseCliArgs(
  argv: string[],
  projectRoot: string,
): CliCommand {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    return { action: "help" };
  }

  const [rawCommand, ...rest] = argv;
  const command =
    rawCommand === "upsert"
      ? "add"
      : rawCommand === "rm"
        ? "delete"
        : rawCommand;

  if (
    command !== "add" &&
    command !== "list" &&
    command !== "enable" &&
    command !== "disable" &&
    command !== "delete"
  ) {
    throw new CliValidationError(
      `Comando desconhecido "${rawCommand}". Comandos disponíveis: add, list, enable, disable, delete.`,
    );
  }

  let positionalSlug: string | undefined;
  let flagSlug: string | undefined;
  let typeRaw: string | undefined;
  let targetRaw: string | undefined;
  let statusRaw: string | undefined;
  let trackHits: 0 | 1 = 0;
  let active: 0 | 1 = 1;
  let skipAssetCheck = false;
  let json = false;
  let sawLocal = false;
  let sawRemote = false;

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];

    if (!token.startsWith("-")) {
      if (positionalSlug === undefined) {
        positionalSlug = token;
        continue;
      }
      throw new CliValidationError(`Argumento posicional inesperado: "${token}".`);
    }

    const flagName = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;

    switch (flagName) {
      case "--slug": {
        const res = readOptionValue(rest, i, "--slug");
        flagSlug = res.value;
        i = res.nextIndex;
        break;
      }
      case "--type": {
        const res = readOptionValue(rest, i, "--type");
        typeRaw = res.value;
        i = res.nextIndex;
        break;
      }
      case "--target": {
        const res = readOptionValue(rest, i, "--target");
        targetRaw = res.value;
        i = res.nextIndex;
        break;
      }
      case "--status": {
        const res = readOptionValue(rest, i, "--status");
        statusRaw = res.value;
        i = res.nextIndex;
        break;
      }
      case "--track-hits":
        trackHits = 1;
        break;
      case "--no-track-hits":
        trackHits = 0;
        break;
      case "--inactive":
        active = 0;
        break;
      case "--active": {
        const res = readOptionValue(rest, i, "--active");
        if (res.value !== "0" && res.value !== "1") {
          throw new CliValidationError(`Valor inválido para --active: "${res.value}". Use 0 ou 1.`);
        }
        active = res.value === "1" ? 1 : 0;
        i = res.nextIndex;
        break;
      }
      case "--skip-asset-check":
        skipAssetCheck = true;
        break;
      case "--json":
        json = true;
        break;
      case "--local":
        sawLocal = true;
        break;
      case "--remote":
        sawRemote = true;
        break;
      default:
        throw new CliValidationError(`Flag desconhecida: "${flagName}".`);
    }
  }

  if (sawLocal && sawRemote) {
    throw new CliValidationError("Use apenas --local ou --remote, nunca ambos.");
  }

  const remote = sawRemote;

  if (command === "list") {
    if (positionalSlug || flagSlug) {
      throw new CliValidationError("O comando list não aceita slug.");
    }
    return { action: "list", json, remote };
  }

  const slug = validateSlug(flagSlug ?? positionalSlug);

  if (command === "enable" || command === "disable" || command === "delete") {
    return { action: command, slug, remote };
  }

  if (typeRaw !== "redirect" && typeRaw !== "page") {
    throw new CliValidationError(
      `Tipo inválido "${typeRaw ?? ""}". Informe --type redirect ou --type page.`,
    );
  }

  let statusCode: 301 | 302 = 301;
  if (statusRaw !== undefined) {
    if (statusRaw !== "301" && statusRaw !== "302") {
      throw new CliValidationError(
        `Status HTTP inválido "${statusRaw}". Valores permitidos: 301 ou 302.`,
      );
    }
    statusCode = statusRaw === "302" ? 302 : 301;
  }

  const target = validateTarget(typeRaw, targetRaw, projectRoot, skipAssetCheck);

  return {
    action: "add",
    slug,
    type: typeRaw,
    target,
    statusCode,
    active,
    trackHits,
    skipAssetCheck,
    remote,
  };
}

export function buildSqlForCommand(
  cmd: Exclude<CliCommand, { action: "help" }>,
): string {
  switch (cmd.action) {
    case "add":
      return [
        "INSERT INTO routes (slug, type, target, status_code, active, track_hits, updated_at)",
        `VALUES (${escapeSqlString(cmd.slug)}, ${escapeSqlString(cmd.type)}, ${escapeSqlString(cmd.target)}, ${cmd.statusCode}, ${cmd.active}, ${cmd.trackHits}, datetime('now'))`,
        "ON CONFLICT(slug) DO UPDATE SET",
        "  type = excluded.type,",
        "  target = excluded.target,",
        "  status_code = excluded.status_code,",
        "  active = excluded.active,",
        "  track_hits = excluded.track_hits,",
        "  updated_at = datetime('now');",
      ].join("\n");
    case "list":
      return "SELECT slug, type, target, status_code, active, track_hits, hits, last_hit_at, created_at, updated_at FROM routes ORDER BY slug ASC;";
    case "enable":
      return `UPDATE routes SET active = 1, updated_at = datetime('now') WHERE slug = ${escapeSqlString(cmd.slug)} RETURNING slug;`;
    case "disable":
      return `UPDATE routes SET active = 0, updated_at = datetime('now') WHERE slug = ${escapeSqlString(cmd.slug)} RETURNING slug;`;
    case "delete":
      return `DELETE FROM routes WHERE slug = ${escapeSqlString(cmd.slug)} RETURNING slug;`;
  }
}

export function formatRoutesTable(rows: RouteRow[]): string {
  if (rows.length === 0) {
    return "Nenhuma rota cadastrada.";
  }

  const headers = [
    "slug",
    "type",
    "target",
    "status_code",
    "active",
    "track_hits",
    "hits",
    "last_hit_at",
  ] as const;

  const stringRows = rows.map((row) => [
    row.slug,
    row.type,
    row.target,
    String(row.status_code),
    String(row.active),
    String(row.track_hits),
    String(row.hits),
    row.last_hit_at ?? "-",
  ]);

  const widths = headers.map((header, idx) =>
    Math.max(
      header.length,
      ...stringRows.map((cells) => cells[idx].length),
    ),
  );

  const formatRow = (cells: readonly string[]) =>
    cells.map((cell, idx) => cell.padEnd(widths[idx])).join("  ");

  const separator = widths.map((w) => "-".repeat(w)).join("  ");

  return [
    formatRow(headers),
    separator,
    ...stringRows.map((cells) => formatRow(cells)),
  ].join("\n");
}
