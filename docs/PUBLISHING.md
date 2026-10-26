# Publishing checklist

Everything in the repo is ready; these steps need your accounts, so they are yours to run. Do them in this order: the registry and the plugin both point at the npm package version.

## 1. npm (required first)

```bash
npm login
npm publish            # runs the tests and the build first (prepublishOnly)
```

Check that https://www.npmjs.com/package/mcp-server-for-bambu shows 0.3.0 and that its `package.json` contains `"mcpName": "io.github.b84330808/mcp-server-for-bambu"`. The MCP Registry checks that field to confirm you own the package.

## 2. Official MCP Registry

Install `mcp-publisher` (Windows PowerShell; see the [quickstart](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx) for macOS/Linux):

```powershell
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq "Arm64") { "arm64" } else { "amd64" }; Invoke-WebRequest -Uri "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_windows_$arch.tar.gz" -OutFile "mcp-publisher.tar.gz"; tar xf mcp-publisher.tar.gz mcp-publisher.exe; rm mcp-publisher.tar.gz
```

Then, from the repo root:

```bash
mcp-publisher validate      # CI runs this too
mcp-publisher login github  # device-code login as b84330808
mcp-publisher publish
```

Verify: `curl "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.b84330808/mcp-server-for-bambu"`.

Directories that read the official registry (for example PulseMCP) pick the server up from there over the following days.

## 3. Claude Code plugin

Nothing to submit for people to use it: after this branch is merged, anyone can run

```
/plugin marketplace add b84330808/mcp-server-for-bambu
/plugin install bambu-printer@mcp-server-for-bambu
```

Test that once yourself after npm 0.3.0 is live (the plugin runs `npx -y mcp-server-for-bambu@0.3.0`).

Optional: submit the plugin to Anthropic's plugin directory (see "Submit to Anthropic's directory" in the [Claude Code plugin docs](https://code.claude.com/docs/en/plugins/publish.md)).

## 4. Other MCP directories (optional)

Each has its own form or PR process; check its current instructions before submitting.

- **Glama** (glama.ai/mcp/servers): indexes GitHub; `glama.json` in the repo root lists you as maintainer so you can claim the listing.
- **mcp.so**: submit the GitHub URL through the site's submit form.
- **Smithery** (smithery.ai): needs a Smithery account and its own build config; skip unless you want it there.
- **awesome-mcp-servers** (github.com/punkpeye/awesome-mcp-servers): open a PR adding one line under the relevant category, following that repo's format rules.
- **Cursor directory** (cursor.directory): submit through the site.

## 5. On every release

Bump the version in all of these together (the `metadata` test fails if they disagree):

- `package.json` (`version`), then `npm install --package-lock-only`
- `server.json` (`version` and `packages[0].version`)
- `plugins/bambu-printer/.claude-plugin/plugin.json` (`version` and the `@x.y.z` in `args`)

Then `npm publish`, `mcp-publisher publish`, and push.
