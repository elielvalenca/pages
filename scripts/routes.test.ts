import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  buildSqlForCommand,
  CliValidationError,
  escapeSqlString,
  formatRoutesTable,
  parseCliArgs,
} from "./routes-core.ts";
import { runCli, type D1Executor } from "./routes.ts";

describe("parseCliArgs & validações", () => {
  it("interpreta add redirect com valores padrão e ambiente local", () => {
    const cmd = parseCliArgs(
      ["add", "matriz", "--type", "redirect", "--target", "https://elielvalenca.com/matriz"],
      "/tmp",
    );
    assert.deepEqual(cmd, {
      action: "add",
      slug: "matriz",
      type: "redirect",
      target: "https://elielvalenca.com/matriz",
      statusCode: 301,
      active: 1,
      trackHits: 0,
      skipAssetCheck: false,
      remote: false,
    });
  });

  it("interpreta add com status 302, --track-hits, --inactive e --remote", () => {
    const cmd = parseCliArgs(
      [
        "add",
        "live",
        "--type",
        "redirect",
        "--target",
        "https://youtube.com/live/123",
        "--status",
        "302",
        "--track-hits",
        "--inactive",
        "--remote",
      ],
      "/tmp",
    );
    assert.deepEqual(cmd, {
      action: "add",
      slug: "live",
      type: "redirect",
      target: "https://youtube.com/live/123",
      statusCode: 302,
      active: 0,
      trackHits: 1,
      skipAssetCheck: false,
      remote: true,
    });
  });

  it("valida existência de public/_pages/<target>/index.html para type=page", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "pages-cli-test-"));
    try {
      assert.throws(
        () =>
          parseCliArgs(
            ["add", "mentoria", "--type", "page", "--target", "mentoria-v1"],
            tempRoot,
          ),
        CliValidationError,
      );

      const bypassed = parseCliArgs(
        [
          "add",
          "mentoria",
          "--type",
          "page",
          "--target",
          "mentoria-v1",
          "--skip-asset-check",
        ],
        tempRoot,
      );
      assert.equal(bypassed.action, "add");

      const pageDir = path.join(tempRoot, "public", "_pages", "mentoria-v1");
      mkdirSync(pageDir, { recursive: true });
      writeFileSync(path.join(pageDir, "index.html"), "<h1>OK</h1>", "utf8");

      const valid = parseCliArgs(
        ["add", "mentoria", "--type", "page", "--target", "mentoria-v1"],
        tempRoot,
      );
      assert.equal(valid.action, "add");
      if (valid.action === "add") {
        assert.equal(valid.target, "mentoria-v1");
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejeita slugs reservados, barras, URLs inválidas e status fora de 301/302", () => {
    for (const badSlug of ["_pages", "_assets", "404.html", "/matriz", "a/b", ".."]) {
      assert.throws(
        () =>
          parseCliArgs(
            ["add", badSlug, "--type", "redirect", "--target", "https://elielvalenca.com"],
            "/tmp",
          ),
        CliValidationError,
      );
    }

    assert.throws(
      () =>
        parseCliArgs(
          ["add", "ok", "--type", "redirect", "--target", "ftp://elielvalenca.com"],
          "/tmp",
        ),
      CliValidationError,
    );

    assert.throws(
      () =>
        parseCliArgs(
          [
            "add",
            "ok",
            "--type",
            "redirect",
            "--target",
            "https://elielvalenca.com",
            "--status",
            "307",
          ],
          "/tmp",
        ),
      CliValidationError,
    );

    assert.throws(() => parseCliArgs(["unknown"], "/tmp"), CliValidationError);
    assert.throws(
      () => parseCliArgs(["list", "--local", "--remote"], "/tmp"),
      CliValidationError,
    );
  });
});

describe("SQL escaping e builders", () => {
  it("escapa aspas simples corretamente e gera upsert/update/delete", () => {
    assert.equal(escapeSqlString("a'b"), "'a''b'");

    const addSql = buildSqlForCommand({
      action: "add",
      slug: "promo",
      type: "redirect",
      target: "https://example.com/?q=O'Reilly",
      statusCode: 302,
      active: 1,
      trackHits: 1,
      skipAssetCheck: false,
      remote: false,
    });
    assert.match(addSql, /'https:\/\/example\.com\/\?q=O''Reilly'/);
    assert.match(addSql, /ON CONFLICT\(slug\) DO UPDATE SET/);

    assert.match(
      buildSqlForCommand({ action: "disable", slug: "promo", remote: false }),
      /SET active = 0.*WHERE slug = 'promo' RETURNING slug;/,
    );
    assert.match(
      buildSqlForCommand({ action: "enable", slug: "promo", remote: false }),
      /SET active = 1.*WHERE slug = 'promo' RETURNING slug;/,
    );
    assert.match(
      buildSqlForCommand({ action: "delete", slug: "promo", remote: false }),
      /DELETE FROM routes WHERE slug = 'promo' RETURNING slug;/,
    );
  });
});

describe("runCli", () => {
  it("formata listagem tabular e JSON e repassa flag --remote", () => {
    const calls: Array<{ sql: string; remote: boolean }> = [];
    const executor: D1Executor = <T>(sql: string, remote: boolean): T[] => {
      calls.push({ sql, remote });
      return [
        {
          slug: "matriz",
          type: "redirect",
          target: "https://elielvalenca.com/matriz",
          status_code: 301,
          active: 1,
          track_hits: 1,
          hits: 42,
          last_hit_at: "2026-11-17T20:00:00.000Z",
        },
      ] as unknown as T[];
    };

    const outLines: string[] = [];
    const errLines: string[] = [];

    const codeTable = runCli(["list"], {
      executor,
      stdout: (t) => outLines.push(t),
      stderr: (t) => errLines.push(t),
    });
    assert.equal(codeTable, 0);
    assert.equal(calls[0].remote, false);
    assert.match(outLines[0], /matriz/);
    assert.match(outLines[0], /42/);

    const codeJson = runCli(["list", "--json", "--remote"], {
      executor,
      stdout: (t) => outLines.push(t),
      stderr: (t) => errLines.push(t),
    });
    assert.equal(codeJson, 0);
    assert.equal(calls[1].remote, true);
    const parsed = JSON.parse(outLines[1]) as Array<{ slug: string }>;
    assert.equal(parsed[0].slug, "matriz");
    assert.equal(errLines.length, 0);
  });

  it("retorna código 1 quando enable/disable/delete não encontra slug", () => {
    const executor: D1Executor = <T>(): T[] => [];
    const errLines: string[] = [];

    const code = runCli(["disable", "nao-existe"], {
      executor,
      stdout: () => {},
      stderr: (t) => errLines.push(t),
    });
    assert.equal(code, 1);
    assert.match(errLines[0], /não encontrada/);
  });

  it("retorna código 1 em erro de validação sem invocar D1", () => {
    let called = false;
    const executor: D1Executor = <T>(): T[] => {
      called = true;
      return [];
    };
    const errLines: string[] = [];

    const code = runCli(["add", "_pages", "--type", "redirect", "--target", "https://a.com"], {
      executor,
      stdout: () => {},
      stderr: (t) => errLines.push(t),
    });
    assert.equal(code, 1);
    assert.equal(called, false);
    assert.match(errLines[0], /Erro de validação/);
  });

  it("exibe mensagem amigável quando lista está vazia", () => {
    assert.equal(formatRoutesTable([]), "Nenhuma rota cadastrada.");
  });
});
