# ScaffoldCraft CLI

ScaffoldCraft is a command-line toolchain for scaffolding and building TypeScript
service projects. It generates a standard project layout, wires up builds and
tests, and produces deployable artifacts without configuration.

## Environment setup

The fictional `scaffoldcraft` binary is assumed to already be installed and available
on `PATH` in the example environment (Node.js 20 or later required). No public registry
package installation is required or provided.

Verify the local toolchain is available before creating any project:

```bash
scaffoldcraft --version
```

## Creating a project

The `init` command scaffolds a project in a new directory:

1. Run `scaffoldcraft init my-service` to create the project directory.
2. Choose a template when prompted: `api`, `worker`, or `cli`.
3. Enter the generated directory with `cd my-service`.
4. Install dependencies with `npm install`.
5. Start the dev server with `npm run dev` and confirm it responds on port 3000.

## Configuration

Projects read settings from `scaffoldcraft.config.ts` at the repository root. The
file exports a default object; the important fields are:

```typescript
import { defineConfig } from "scaffoldcraft/config";

export default defineConfig({
  entry: "src/main.ts",
  outDir: "dist",
  target: "node20",
  sourcemap: true,
});
```

Do not commit generated output from `dist/` to version control; the default
`.gitignore` created by `init` already excludes it.

## Building and testing

Build a production artifact into `dist/`:

```bash
scaffoldcraft build
```

Run the test suite (Vitest is preconfigured by every template):

```bash
npm test
```

Both commands must pass before you deploy. A build that fails type checks
will not emit a `dist/` artifact.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `SCAFFOLDCRAFT_LOG_LEVEL` | no | `debug`, `info`, `warn`, or `error` (default `info`). |
| `SCAFFOLDCRAFT_PORT` | no | Port for `api` template dev/prod servers (default 3000). |
| `SCAFFOLDCRAFT_TELEMETRY` | no | Set to `0` to disable anonymous usage reporting. |

## Deploying

`scaffoldcraft deploy` publishes the built artifact to the configured target. The
target is read from `scaffoldcraft.config.ts` (`deploy.target`) and supports
`node` and `docker`.

Warning: deploying overwrites the running service immediately; there is no
built-in rollback. Verify `npm test` and `scaffoldcraft build` pass before every
deploy.

## Upgrading

Run migration to upgrade project configuration and schema:

```bash
scaffoldcraft migrate
```

## Troubleshooting

- `command not found: scaffoldcraft` — the local toolchain binary is not on
  your `PATH`; verify your environment configuration and shell profile.
- `template download failed` — network or registry mirror problems; retry
  after checking `npm config get registry`.
- Build hangs at the type-check step — delete `dist/` and the `.scaffoldcraft`
  cache directory, then run `scaffoldcraft build` again.
- `EADDRINUSE` on port 3000 — another process (often a previous dev server)
  is still listening; stop it or set `SCAFFOLDCRAFT_PORT` to a different port.
