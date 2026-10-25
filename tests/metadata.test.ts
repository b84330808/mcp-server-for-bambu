// Keeps the publishing metadata in step with package.json, so a release can't
// ship a server.json or plugin that points at another version.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "..");
const json = (path: string) => JSON.parse(readFileSync(resolve(root, path), "utf-8"));

const pkg = json("package.json");
const server = json("server.json");
const plugin = json("plugins/bambu-printer/.claude-plugin/plugin.json");
const marketplace = json(".claude-plugin/marketplace.json");

describe("publishing metadata", () => {
  it("server.json matches package.json", () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    expect(server.packages[0].identifier).toBe(pkg.name);
    expect(server.packages[0].version).toBe(pkg.version);
    expect(server.description.length).toBeLessThanOrEqual(100);
  });

  it("server.json only documents env vars the server reads", () => {
    const configSrc = readFileSync(resolve(root, "src/config.ts"), "utf-8");
    for (const v of server.packages[0].environmentVariables) {
      expect(configSrc, v.name).toContain(`"${v.name}"`);
    }
  });

  it("the Claude Code plugin runs this package version", () => {
    expect(plugin.version).toBe(pkg.version);
    expect(plugin.mcpServers.bambu.args).toContain(`${pkg.name}@${pkg.version}`);
    expect(marketplace.plugins.map((p: { name: string }) => p.name)).toContain(plugin.name);
  });

  it("every example client config parses and runs the package", () => {
    for (const file of readdirSync(resolve(root, "examples"))) {
      const cfg = json(`examples/${file}`);
      const servers = cfg.mcpServers ?? cfg.servers;
      expect(servers?.bambu?.args, file).toContain(pkg.name);
    }
  });
});
