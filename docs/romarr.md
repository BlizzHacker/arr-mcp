# ROMarr and ROM Hub

ROMarr 0.8.0 or newer gives arr-mcp one authenticated API for the game library,
download queue, indexer search and ROM Hub catalogs. It can also surface the
health of the RomM library, qBittorrent clients and GG Requestz configured in
ROMarr; their credentials stay in ROMarr and are never copied into arr-mcp.

```yaml
services:
  romarr:
    url: http://romarr.lan:7878
    api_key: "your ROMarr API key"
    permissions:
      safe_write: false
      destructive: false
```

The API key is the value ROMarr stores as `settings._api_key` in `romarr.json`.
Keep the base URL free of `/api`; arr-mcp adds the versioned paths itself.

## What to ask

- “Show the first 25 PlayStation 2 games ROMarr knows about.”
- “Search my game library for Metroid.”
- “What is in ROMarr's download queue?”
- “List enabled ROM Hub plugins that have the search capability.”
- “Are ROMarr's qBittorrent, RomM library and GG Requestz connections healthy?”

`get_games` is intentionally separate from `get_library`. The latter joins
Radarr and Sonarr records to Jellyfin presence and watch state; applying those
film/series semantics to games would incorrectly report working ROMs as failed
imports.

`get_indexers` combines Prowlarr indexers with ROMarr's configured/proxied
indexers and ROM Hub plugin sources. `search_media` with `source: "indexers"`
uses ROMarr's live release search as well as the other configured services.

## Third-party plugins

ROMarr returns the merged ROM Hub directory, including any third-party catalog
URLs configured there. `get_plugins` reports each plugin's catalog slug,
repository, declared capabilities, platforms, network hosts and installation
state. Catalog metadata is treated as untrusted service data before it enters
model context.

Plugin writes are off by default. With `safe_write: true`,
`set_plugin_state` can enable or disable an installed plugin. With
`destructive: true`, `manage_plugin_installation` can install or uninstall one.
Every call first returns a preview and a single-use confirmation token. Inspect
the declared repository and network hosts before confirming third-party code.

```text
get_plugins { installed: true, limit: 50 }
set_plugin_state { slug: "example-plugin", enabled: true, dry_run: true }
manage_plugin_installation { slug: "example-plugin", installed: true, dry_run: true }
```

Remove `dry_run` to request a confirmation token, then repeat the exact call
with `confirm` set to that token. No change occurs on the preview call.

## Verify the connection

`stack_health` probes `/api/v1/system/status`. A healthy ROMarr entry includes
its detected version. Broken download clients, unreadable libraries and an
unreachable configured GG Requestz instance appear as separate failures rather
than being hidden behind a successful ROMarr HTTP response.

For a direct transport check, initialize MCP first and then call a read tool:

```bash
curl -s http://arr-mcp.lan:6060/mcp \
  -H 'Authorization: Bearer YOUR_ARR_MCP_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-07-28","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

An MCP client normally manages initialization and sessions for you; the URL is
`http://arr-mcp.lan:6060/mcp` and authentication is an HTTP bearer token.
