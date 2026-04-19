# tagma-editor

A visual editor for Tagma, built with React + Vite + Express, running on **Bun**.

## Requirements

- **Bun** >= 1.3

Check your current version:

```bash
bun --version
```

Install or upgrade Bun (PowerShell on Windows):

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

Or on macOS / Linux:

```bash
curl -fsSL https://bun.sh/install | bash
```

## Getting Started

1. Install dependencies:

   ```bash
   bun install
   ```

2. Start the development environment (runs the Vite dev server and the Express backend in parallel):

   ```bash
   bun run dev
   ```

3. Build the production bundle:

   ```bash
   bun run build
   ```

4. Run the backend in production mode:

   ```bash
   bun start
   ```

5. Preview the built frontend locally:

   ```bash
   bun run preview
   ```

6. Run the test suite:

   ```bash
   bun test
   ```

## Available Scripts

| Script                  | Description                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `bun run dev`           | Run frontend and backend dev servers in parallel                                      |
| `bun run dev:server`    | Run backend only (`bun --watch server/index.ts`)                                      |
| `bun run dev:client`    | Run frontend only (`vite`)                                                            |
| `bun run build`         | Build the frontend for production                                                     |
| `bun run build:sidecar` | Compile the backend into a single-file executable (`bun build --compile`) for desktop |
| `bun start`             | Start the backend in production mode                                                  |
| `bun run preview`       | Preview the production build locally                                                  |
| `bun test`              | Run the test suite                                                                    |
| `bun run check:server`  | Type-check the backend only                                                           |

## Notes

- The entire stack (editor server, SDK, CLI, sandbox) runs on Bun. Do not use `npm` or `node` — scripts assume Bun and the server source imports `Bun.*` globals.
- Task positions are persisted to a sibling `.layout.json` file next to the YAML file, saved on `Ctrl+S`.
- Command-type task cards automatically hide AI-specific fields.
