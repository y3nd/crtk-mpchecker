# crtk-mpchecker

Small Node.js utility to check whether a Centipede-RTK mountpoint name is available.

It can be used in two ways:

- as a CLI tool for one-off checks
- as a tiny HTTP server returning `AVAILABLE` or `TAKEN`

The check combines three sources:

- Grafana mountpoint list
- Lizmap mountpoint layers
- a direct `HEAD` check against `https://crtk.net/<mountpoint>`

## Requirements

- Node.js 18+ recommended

This project uses the built-in `fetch` API and `performance`.

## Files

- `mpchecker-core.js`: shared checking logic and cache layer
- `crtk-mpchecker-cli.js`: command-line entrypoint
- `crtk-mpchecker-server.js`: HTTP server entrypoint

## CLI usage

Run:

```bash
node crtk-mpchecker-cli.js <mountpoint>
```

Example:

```bash
node crtk-mpchecker-cli.js TESTMP
```

Possible outcomes:

- exit code `0`: mountpoint is available
- exit code `2`: mountpoint is already taken
- exit code `1`: error

Enable debug logs:

```bash
node crtk-mpchecker-cli.js TESTMP --debug
```

or:

```bash
DEBUG=1 node crtk-mpchecker-cli.js TESTMP
```

## HTTP server usage

Run:

```bash
node crtk-mpchecker-server.js
```

By default the server listens on:

```text
http://[::]:8010
```

Check a mountpoint with:

```text
GET /<MOUNTPOINT>
```

Examples:

```text
GET /EXISTING     -> TAKEN
GET /NOTEXISTING  -> AVAILABLE
```

If the path is empty or invalid, the server returns a short help text.

### HTTP behavior

- `GET` and `HEAD` are supported
- `OPTIONS` returns CORS headers
- other methods return `405 METHOD NOT ALLOWED`
- rate-limited clients receive `429 TOO MANY REQUESTS`
- backend failures return `500 ERROR`

## Configuration

All configuration is done with environment variables.

### Shared checker settings

- `GRAFANA_URL`  
  Default: `https://gf.centipede-rtk.org`
- `LIZMAP_URL`  
  Default: `https://map.centipede-rtk.org`
- `DATASOURCE_UID`  
  Default: `ef4dj94eoifpcf`
- `DATASOURCE_ID`  
  Default: `24`
- `LIST_CACHE_TTL_MS`  
  Default: `60000`

### Server settings

- `HOST`  
  Default: `::`
- `PORT`  
  Default: `8010`
- `TRUST_PROXY`  
  Default: `0`  
  When set to `1`, the server uses `X-Forwarded-For` for rate limiting.
- `RATE_LIMIT_PER_MINUTE`  
  Default: `20`
- `RATE_LIMIT_PER_HOUR`  
  Default: `100`
- `DEBUG`  
  Set to `1` to enable debug logs

## How availability is determined

A mountpoint is considered available only if:

- it is not present in the Grafana list
- it is not present in the Lizmap layers
- `https://crtk.net/<mountpoint>` does not respond successfully to `HEAD`

Mountpoint names are normalized to uppercase before comparison.

## Example

Run the server on a custom port:

```bash
PORT=8080 DEBUG=1 node crtk-mpchecker-server.js
```

Then query:

```bash
curl http://localhost:8080/MYNEWMP
```

Expected response:

```text
AVAILABLE
```

## Notes

- The mountpoint lists are cached in memory for the configured TTL.
- The server groups IPv6 clients by `/64` subnet for rate limiting.
- There is currently no `package.json`; the scripts can be run directly with Node.js.
