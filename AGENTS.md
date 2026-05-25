# Flue

Agent framework where agents are directories compiled into deployable server artifacts.

## Terminology

```
Agent profile                 — one reusable `defineAgentProfile(...)` value
Created agent                 — one runtime initializer from `createAgent(...)`
Agent module                  — `agents/<name>.ts`; default-exports a created agent
└─ AgentInstance              — URL `<id>`; provided to `createAgent(({ id }))`
   └─ Harness                 — runtime-initialized agent environment; defaults to name `"default"`
      └─ Session              — one `harness.session(name?)`; defaults to `"default"`
         └─ Operation        — one `session.prompt` / `skill` / `task` / `shell` call
            └─ Turn          — one LLM round-trip inside pi-agent-core
Workflow                     — `workflows/<name>.ts`; exports `run(...)`
└─ Workflow run/invocation    — unique `ctx.id === runId`; initializes local created agents via `init(agent)` when needed
```

Runs are workflow-only. Direct HTTP/WebSocket agent prompts and dispatched agent inputs operate within persistent sessions and must not be described as runs. `dispatch(...)` is identified by `dispatchId`; `/runs` and `flue logs` inspect workflow runs only.

Use `harness` as the variable name for the return value of `init()`. Agents have names; agent instances have ids; harnesses and sessions have names; operations have generated ids.

## Project Structure

- `packages/runtime/` — Runtime library (`@flue/runtime`). Session management, agent harness, tools, sandbox plumbing. What a built Flue app depends on.
- `packages/cli/` — CLI + build/dev tooling (`@flue/cli`). Owns `flue dev`/`run`/`build`/`init`/`add`/`logs`, the shared Vite build graph and target integration, topology discovery, env-file loading, and the `flue.config.ts` resolver. Eventually rolls up into the `flue` npm package; for now `defineConfig` is imported via `@flue/cli/config`.
- `examples/hello-world/` — Test root with example agents covering the runtime's surfaces.
- `examples/cloudflare/` — Test root for Cloudflare-specific features (Workers AI binding, etc.).
- `examples/imported-skill/` — Copyable packaged `SkillReference` example and packed-package release fixture.

## Building

Runtime must be built before CLI or example agents:

```
pnpm run build          # in packages/runtime/
pnpm run build          # in packages/cli/
```

## Running and Connecting

Four commands:

- `flue dev` — long-running watch-mode dev server. Edits trigger rebuilds + reloads.
- `flue run` — one-shot, production-style: build, invoke a workflow once, exit. Used in CI / scripted invocations.
- `flue connect` — build and open an interactive local session with an agent instance.
- `flue build` — produce a `dist/` deployable artifact (no run).

`--root` points at the project root. Defaults to the current working directory if omitted. By default, the build is written to `<root>/dist/`; use `--output <path>` to redirect the build elsewhere.

Source files (agents and workflows) live in one of two places, analogous to Next.js's `src/` folder:

- `<root>/.flue/agents/` and `<root>/.flue/workflows/` if a `.flue/` directory exists.
- Otherwise `<root>/agents/` and `<root>/workflows/` directly.

The two layouts never mix — if `.flue/` is present, the bare layout is ignored entirely.

### `flue.config.ts`

A `flue.config.{ts,mts,mjs,js,cjs,cts}` file at the project root may set `target`, `root`, or `output`. Discovered automatically (or via `--config <path>`). CLI flags always override values from the config file.

```ts
// flue.config.ts
import { defineConfig } from '@flue/cli/config';

export default defineConfig({
  target: 'node',
});
```

Relative `root` / `output` values resolve against the directory containing the config file (Vite-style: the config file's dir IS the project root). The config is loaded via Node's native TS support (Node ≥ 22.18).

### Skills

Workspace skills at `<cwd>/.agents/skills/<name>/SKILL.md` are discovered lazily at runtime and activated with `session.skill('name')`. Authored modules can instead import a spec-compliant `SKILL.md` directory with `with { type: 'skill' }`; Vite packages the complete permitted directory and exposes a `SkillReference`. Activate it directly with `session.skill(reference)`, or register it in `skills: [reference]` and activate by name. Imported skill directories must not contain credentials/private keys; sensitive paths reject builds.

### `flue dev`

Default port: `3583` ("FLUE" on a phone keypad). Override with `--port`.

```
cd examples/hello-world
node ../../packages/cli/bin/flue.mjs dev --target node
# or:
node ../../packages/cli/bin/flue.mjs dev --target cloudflare
```

For `--target cloudflare`, the project must have `wrangler` available (it's a peer dependency of `@flue/cli`). Cloudflare local development uses the official Vite/workerd path plus `.dev.vars`/`.env` and `CLOUDFLARE_ENV`; `--env <path>` is Node-only.

### `flue run`

```
node packages/cli/bin/flue.mjs run <workflow-name> --target node [--payload '<json>'] [--root <path>] [--output <path>]
```

Examples (run from the `examples/hello-world/` directory so the `./.flue/` source layout is picked up):

```
cd examples/hello-world
node ../../packages/cli/bin/flue.mjs run hello --target node
node ../../packages/cli/bin/flue.mjs run with-thinking --target node
```

This builds the project, invokes the workflow through a private local child-process channel, streams output to stderr, prints the final result to stdout, and exits. Workflows do not need public HTTP or WebSocket exposure for local `flue run`.

### `flue connect`

```
node packages/cli/bin/flue.mjs connect <agent-name> <instance-id> --target node [--session <name>] [--root <path>] [--output <path>]
```

This builds the project and opens an interactive local connection to one agent instance. Enter one prompt per line; the child process stays alive until the connection closes so in-memory session state can continue between prompts.

**Requires `ANTHROPIC_API_KEY` in the environment.** For testing, use `claude-haiku-4-5` (cheapest model).

## Type Checking

```
pnpm run check:types    # in packages/runtime/
```

## Models

`provider/model-id` strings; providers come from pi-ai's registry. API keys via env (`ANTHROPIC_API_KEY`, etc.) or provider configuration in `app.ts` via `configureProvider()` / `registerProvider()`.

```ts
createAgent(() => ({ model: 'anthropic/claude-sonnet-4-6' }))
createAgent(() => ({ model: 'openai/gpt-4.1-mini' }))
```

`cloudflare/...` routes through `env.AI.run()` on the Cloudflare target — no API keys, just `"ai": { "binding": "AI" }` in `wrangler.jsonc`. Errors clearly on `--target node`.

```ts
createAgent(() => ({ model: 'cloudflare/@cf/moonshotai/kimi-k2.6' }))
```

## Architecture

### Agent = Deployed Workspace

A repo is built and deployed as an agent. `flue build` compiles the root (skills, agents, context) into a self-contained server artifact. On every push to main, the agent is rebuilt and redeployed.

## Development

When using `task` to delegate to subagents, you MUST include a notice to the subagent to not spawn their own subagents. Otherwise we end up with inifinite spawning subagent chains.

When accepting "review" task feedback, take durability and reliability bugs and improvement suggestions seriously, but be cautious of getting stuck in design churn hell. Reviews will almost always return *something*, so it's up to you as the main agent to understand when enough is enough, and to have a high bar for review feedback to be actionable.

When writing new plans to disk, write them to `plans/` directory (gitignored, intentionally) with a YYYY-MM-DD filename prefix.