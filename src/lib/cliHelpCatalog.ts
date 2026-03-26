export type HelpEntry = {
    command: string;
    description: string;
    useWhen?: string;
    scenario?: string;
};

export type OptionGuideEntry = {
    option: string;
    meaning: string;
    useWhen: string;
};

export const START_HERE_HELP: HelpEntry[] = [
    {
        command: 'iranti setup',
        description: 'Guided first-run setup for runtime root, database, instance, keys, and optional project binding.',
        useWhen: 'you are installing Iranti on a machine or want the CLI to walk you through the whole bootstrap path.',
        scenario: 'A fresh laptop or server where you want one command to get from zero to a runnable instance.',
    },
    {
        command: 'iranti run --instance local',
        description: 'Start a configured instance and record runtime metadata so status, restart, and health checks can see it.',
        useWhen: 'the instance already exists and you want the API server to actually start.',
        scenario: 'You finished setup or instance create/configure and now need the Iranti API listening on its port.',
    },
    {
        command: 'iranti doctor',
        description: 'Validate environment, database, provider keys, and runtime health before or after launch.',
        useWhen: 'something feels off, or before you trust a setup enough to hand it to Claude, Codex, or another client.',
        scenario: 'You changed provider keys, switched databases, or want a fast pass/fail diagnostic before debugging deeper.',
    },
    {
        command: 'iranti chat',
        description: 'Open the local Iranti chat shell against the configured runtime.',
        useWhen: 'you want an interactive sanity check or demo without writing client code first.',
        scenario: 'You just brought up an instance and want to confirm the runtime responds end to end.',
    },
];

export const SETUP_AND_RUNTIME_HELP: HelpEntry[] = [
    {
        command: 'iranti install [--scope user|system] [--root <path>]',
        description: 'Initialize runtime folders without doing the full guided setup flow.',
        useWhen: 'you want low-level control over the runtime root before creating instances manually.',
        scenario: 'Preparing a machine-level root ahead of scripted `instance create` calls.',
    },
    {
        command: 'iranti setup [--scope user|system] [--root <path>] [--mode isolated|shared] [--instance <name>] [--port <n>] [--config <file> | --defaults] [--db-mode local|managed|docker] [--db-url <url>] [--provider <name>] [--api-key <token>] [--projects <path1,path2>] [--auto-remember [true|false]] [--claude-code] [--bootstrap-db]',
        description: 'Guided setup for runtime, database, instance, keys, and project binding.',
        useWhen: 'you want the CLI to explain the decisions and create a runnable starting point with minimal manual editing.',
        scenario: 'The normal first-run path for a developer machine, test box, or new local project.',
    },
    {
        command: 'iranti instance create <name> [--port 3001] [--db-url <url>] [--api-key <token>] [--provider <name>] [--provider-key <token>] [--scope user|system]',
        description: 'Create one instance directly without the setup wizard.',
        useWhen: 'you already know your database URL, port, and provider choices and want a scriptable primitive.',
        scenario: 'Provisioning multiple named instances under one runtime root.',
    },
    {
        command: 'iranti instance list [--scope user|system]',
        description: 'List configured instances under the active runtime root.',
        useWhen: 'you need to see what instances exist before showing, running, configuring, or binding one.',
        scenario: 'Checking whether `local`, `staging`, or another named instance already exists.',
    },
    {
        command: 'iranti instance show <name> [--scope user|system]',
        description: 'Show one instance env, port, database target, and runtime state.',
        useWhen: 'you are investigating one specific instance and need its exact configuration.',
        scenario: 'Confirming which port `local` uses before binding a project or debugging a runtime mismatch.',
    },
    {
        command: 'iranti instance restart <name> [--scope user|system] [--graceful-timeout <seconds>]',
        description: 'Restart a running instance using runtime metadata.',
        useWhen: 'the instance is already running and you changed env/config or installed a newer CLI/runtime.',
        scenario: 'Picking up a new provider key or new release without manually hunting the process.',
    },
    {
        command: 'iranti run --instance <name> [--scope user|system]',
        description: 'Start an instance and write runtime metadata.',
        useWhen: 'the instance exists on disk but the API process is not running yet.',
        scenario: 'Bringing `local` online after setup, reboot, or a stop/restart cycle.',
    },
];

export const CONFIGURATION_HELP: HelpEntry[] = [
    {
        command: 'iranti configure instance <name> [--interactive] [--db-url <url>] [--port <n>] [--api-key <token>] [--provider <name>] [--provider-key <token>] [--clear-provider-key] [--json]',
        description: 'Update an instance without editing env files manually.',
        useWhen: 'you need to change one existing instance after creation rather than recreate it from scratch.',
        scenario: 'Switching from `mock` to `openai`, rotating provider keys, or moving the instance to a new port.',
    },
    {
        command: 'iranti project init [path] --instance <name> [--api-key <token>] [--agent-id <id>] [--mode isolated|shared] [--auto-remember [true|false]] [--force]',
        description: 'Create a new `.env.iranti` binding for one project.',
        useWhen: 'a repo should point at an Iranti instance for Claude, Codex, MCP, or direct SDK/API use.',
        scenario: 'Binding `iranti-control-plane` or another repo root to `local` so it can use shared memory.',
    },
    {
        command: 'iranti configure project [path] [--interactive] [--instance <name>] [--url <http://host:port>] [--api-key <token>] [--agent-id <id>] [--memory-entity <entity>] [--auto-remember [true|false]] [--mode isolated|shared] [--json]',
        description: 'Refresh or retarget an existing project binding.',
        useWhen: 'the project is already bound and you want to change its instance, URL, key, agent identity, or memory entity.',
        scenario: 'Moving a repo from `local` to `shared_team` or fixing a wrong `IRANTI_PROJECT_MODE`.',
    },
];

export const KEY_HELP: HelpEntry[] = [
    {
        command: 'iranti auth create-key --instance <name> --key-id <id> --owner <owner> [--scopes kb:read,kb:write:project/*] [--description <text>] [--write-instance] [--project <path>] [--agent-id <id>] [--json]',
        description: 'Create or rotate an Iranti client key.',
        useWhen: 'a human, app, or project needs its own authenticated key for the Iranti API.',
        scenario: 'Issuing a project-scoped key during onboarding or rotating a leaked key.',
    },
    {
        command: 'iranti auth list-keys --instance <name> [--json]',
        description: 'List registry-backed Iranti client keys.',
        useWhen: 'you need to audit what keys exist before rotating or revoking them.',
        scenario: 'Checking whether a project already has a key before creating another one.',
    },
    {
        command: 'iranti auth revoke-key --instance <name> --key-id <id> [--json]',
        description: 'Revoke an Iranti client key.',
        useWhen: 'a key should stop working immediately because it is old, leaked, or no longer needed.',
        scenario: 'Removing access for a retired app or invalidating a compromised credential.',
    },
    {
        command: 'iranti list api-keys [--instance <name>] [--project <path>] [--json]',
        description: 'Show stored upstream provider keys.',
        useWhen: 'you need to see which providers are configured for an instance or bound project.',
        scenario: 'Checking whether `openai` or `claude` already has a stored key before switching providers.',
    },
    {
        command: 'iranti add api-key [provider] [--instance <name>] [--project <path>] [--key <token>] [--set-default] [--json]',
        description: 'Store a provider key and optionally make it the default.',
        useWhen: 'a provider is not configured yet and you want the instance to start using it.',
        scenario: 'Adding an OpenAI key after initial setup and making OpenAI the active provider.',
    },
    {
        command: 'iranti update api-key [provider] [--instance <name>] [--project <path>] [--key <token>] [--set-default] [--json]',
        description: 'Replace a stored provider key.',
        useWhen: 'the provider credential changed but the provider itself stays the same.',
        scenario: 'Rotating an expired Anthropic key without touching the rest of the instance config.',
    },
    {
        command: 'iranti remove api-key [provider] [--instance <name>] [--project <path>] [--json]',
        description: 'Remove a stored provider key.',
        useWhen: 'a provider should no longer be available from this instance or bound project.',
        scenario: 'Cleaning up an old Gemini credential after standardizing on OpenAI.',
    },
];

export const DIAGNOSTICS_HELP: HelpEntry[] = [
    {
        command: 'iranti version',
        description: 'Print the installed CLI version and related package versions, while keeping non-interactive output script-friendly.',
        useWhen: 'you need to confirm which release is on PATH before debugging or upgrading, or you want the terminal to show the matching Python and TypeScript package versions too.',
        scenario: 'Checking whether your global install picked up the latest npm release.',
    },
    {
        command: 'iranti doctor [--instance <name>] [--scope user|system] [--env <file>] [--json] [--debug]',
        description: 'Run environment and runtime diagnostics.',
        useWhen: 'you want a fast pass/fail check before doing deeper manual investigation.',
        scenario: 'Verifying database, provider key, and runtime readiness after setup or after a config change.',
    },
    {
        command: 'iranti status [--scope user|system] [--json]',
        description: 'Show runtime roots, bindings, and known instances.',
        useWhen: 'you need the operator overview: what root is active, what is bound, and what is actually running.',
        scenario: 'Understanding whether a project binding points at the same runtime root the CLI is inspecting.',
    },
    {
        command: 'iranti upgrade [--check] [--dry-run] [--yes] [--all] [--target auto|npm-global|npm-repo|python[,python]] [--json]',
        description: 'Check or run CLI/runtime/package upgrades.',
        useWhen: 'you want to see whether a newer npm or PyPI release exists or apply it safely.',
        scenario: 'Preparing to move a machine from `0.2.23` to the next patch release.',
    },
    {
        command: 'iranti uninstall [--dry-run] [--yes] [--all] [--keep-data] [--keep-project-bindings] [--scan-root <dir[,dir2]>] [--json]',
        description: 'Remove Iranti packages and, with `--all`, runtime data and project integrations.',
        useWhen: 'you are cleaning a machine up or resetting an install and want to control what gets preserved.',
        scenario: 'Removing the CLI from a machine while keeping project bindings, or doing a full wipe before reinstalling.',
    },
    {
        command: 'iranti handshake [--instance <name> | --project-env <file>] [--agent <id>] [--task <text>] [--recent <msg1||msg2>] [--recent-file <path>] [--json]',
        description: 'Manually inspect Attendant handshake output.',
        useWhen: 'you need to see what working-memory brief an agent would receive before a session starts.',
        scenario: 'Verifying that a project binding and agent identity resolve to the right memory context.',
    },
    {
        command: 'iranti attend [message] [--instance <name> | --project-env <file>] [--agent <id>] [--context <text> | --context-file <path>] [--entity-hint <entity>] [--force] [--max-facts <n>] [--json]',
        description: 'Manually inspect turn-level memory injection decisions.',
        useWhen: 'you want to debug why memory is or is not being injected for one specific prompt.',
        scenario: 'Investigating an agent turn where relevant facts were missing or too many facts were pulled in.',
    },
    {
        command: 'iranti handoff task/<task_id> [--instance <name> | --project-env <file>] [--agent <id>] --next-step <text> [--status <state>] [--owner <agent-id>] [--blockers <a||b>] [--artifacts <path1||path2>] [--project-entity <entity>] [--notes <text>] [--source <label>] [--confidence <n>] [--json]',
        description: 'Write a standardized shared-memory handoff for Claude/Codex collaboration.',
        useWhen: 'one tool or agent should leave structured next-step context for another tool or agent.',
        scenario: 'Claude finishes analysis and Codex needs a durable task handoff with blockers and artifacts.',
    },
    {
        command: 'iranti chat [--agent <agent-id>] [--provider <provider>] [--model <model>]',
        description: 'Open the local interactive chat shell.',
        useWhen: 'you want to talk to a live runtime directly from the terminal.',
        scenario: 'Quick sanity checking after setup without opening another client or UI.',
    },
    {
        command: 'iranti resolve [--dir <escalation-dir>]',
        description: 'Walk through pending escalation files.',
        useWhen: 'human review is required for unresolved conflicts in the escalation folder.',
        scenario: 'Cleaning up contradictions that the Librarian could not settle deterministically or with LLM reasoning.',
    },
];

export const INTEGRATIONS_HELP: HelpEntry[] = [
    {
        command: 'iranti mcp [--help]',
        description: 'Start the stdio MCP server.',
        useWhen: 'Claude Code, Codex, or another MCP client should talk to Iranti over MCP instead of raw HTTP.',
        scenario: 'Registering Iranti as a tool source for Claude Code or Codex.',
    },
    {
        command: 'iranti claude-setup [path] [--project-env <path>] [--force]',
        description: 'Scaffold Claude Code files for one project.',
        useWhen: 'one bound repo should get `.mcp.json` and Claude hook files without hand-editing them.',
        scenario: 'Setting up `iranti-control-plane` so Claude Code can use the same Iranti instance.',
    },
    {
        command: 'iranti claude-setup --scan <dir> [--recursive] [--force]',
        description: 'Find Claude-enabled projects and scaffold them in batch.',
        useWhen: 'you have many repos and want to apply Claude scaffolding to all eligible ones under a parent directory.',
        scenario: 'Bootstrapping several repos in `C:\\Users\\NF\\Documents\\Projects` at once.',
    },
    {
        command: 'iranti claude-hook --event SessionStart|UserPromptSubmit|Stop [--project-env <path>] [--instance-env <path>] [--env-file <path>]',
        description: 'Run the Claude Code hook helper directly.',
        useWhen: 'you are debugging Claude hook behavior or invoking the hook outside normal Claude execution.',
        scenario: 'Testing whether the SessionStart hook can resolve the right project binding.',
    },
    {
        command: 'iranti codex-setup [--name iranti] [--agent codex_code] [--source Codex] [--provider openai] [--project-env <path>] [--local-script] [--no-workspace-file]',
        description: 'Register Iranti with the Codex CLI and, by default, write a project-local `.mcp.json` when a binding is available.',
        useWhen: 'Codex should see Iranti through its global MCP configuration and the current bound workspace should get a deterministic `.mcp.json` entry.',
        scenario: 'Making the `codex` CLI able to call Iranti tools from bound repos.',
    },
    {
        command: 'iranti integrate claude [path] [--project-env <path>] [--force]',
        description: 'Alias for Claude setup.',
        useWhen: 'you prefer the integration verb but want the same behavior as `claude-setup`.',
        scenario: 'Scripting project setup with a more verb-oriented command name.',
    },
    {
        command: 'iranti integrate claude --scan <dir> [--recursive] [--force]',
        description: 'Alias for batch Claude setup.',
        useWhen: 'same as `claude-setup --scan`, but called through the integration command group.',
        scenario: 'Applying the same Claude scaffolding workflow under a directory tree.',
    },
    {
        command: 'iranti integrate codex [--name iranti] [--agent codex_code] [--source Codex] [--provider openai] [--project-env <path>] [--local-script] [--no-workspace-file]',
        description: 'Alias for Codex setup.',
        useWhen: 'same as `codex-setup`, but called through the integration command group.',
        scenario: 'Registering the Codex MCP server from a script that groups integrations under one verb.',
    },
];

export const SETUP_COMMAND_HELP: HelpEntry[] = [
    {
        command: 'iranti setup [--scope user|system] [--root <path>] [--mode isolated|shared] [--instance <name>] [--port <n>] [--config <file> | --defaults] [--db-mode local|managed|docker] [--db-url <url>] [--provider <name>] [--api-key <token>] [--projects <path1,path2>] [--auto-remember [true|false]] [--claude-code] [--bootstrap-db]',
        description: 'Interactive or automation-friendly first-run setup for runtime, database, instance, provider keys, Iranti client key, and optional project bindings.',
        useWhen: 'you want one command to either explain setup choices interactively or execute a known setup plan non-interactively.',
        scenario: 'Bootstrapping a new project in isolated mode, or provisioning a shared runtime with multiple bound repos from a config file.',
    },
];

export const SETUP_OPTION_GUIDE: OptionGuideEntry[] = [
    { option: '--scope user|system', meaning: 'Selects the shared runtime install scope when you are not providing an explicit runtime root.', useWhen: 'you want the CLI to choose the usual user-level or system-level shared location for you.' },
    { option: '--root <path>', meaning: 'Pins setup to one explicit runtime root path instead of letting the CLI infer it.', useWhen: 'you want a deterministic isolated runtime folder or a custom shared runtime location.' },
    { option: '--mode isolated|shared', meaning: 'Chooses whether setup defaults to one-project-per-runtime (`isolated`) or one runtime shared across projects (`shared`).', useWhen: 'use `isolated` for one repo with its own memory/runtime boundary; use `shared` when multiple repos should intentionally point at the same instance.' },
    { option: '--instance <name>', meaning: 'Sets the instance name to create or update.', useWhen: 'you already know the instance name and do not want the wizard to prompt for it.' },
    { option: '--port <n>', meaning: 'Sets the API port for the instance.', useWhen: 'you need a predictable port or are avoiding a known port collision.' },
    { option: '--config <file>', meaning: 'Reads a JSON setup plan and executes it without asking questions.', useWhen: 'you want repeatable automation in CI, scripts, or documented team setup.' },
    { option: '--defaults', meaning: 'Runs setup non-interactively from flags plus environment/default values.', useWhen: 'you want quick automation but do not need the full explicitness of a saved config file.' },
    { option: '--db-mode local|managed|docker', meaning: 'Selects how PostgreSQL is sourced during automated setup.', useWhen: 'use `local` for your own postgres on the machine, `docker` for containerized local pgvector, or `managed` for a remote connection string you already own.' },
    { option: '--db-url <url>', meaning: 'Supplies the PostgreSQL connection string directly.', useWhen: 'you already know the target database and do not want the CLI to derive it.' },
    { option: '--provider <name>', meaning: 'Sets the default LLM provider for the instance.', useWhen: 'you want setup to land on `openai`, `claude`, `gemini`, `mock`, or another supported provider immediately.' },
    { option: '--api-key <token>', meaning: 'Supplies the instance `IRANTI_API_KEY` instead of generating or rotating one during setup.', useWhen: 'you need a predetermined client key because another system already expects it.' },
    { option: '--projects <path1,path2>', meaning: 'Binds one or more project roots during non-interactive setup.', useWhen: 'the setup flow should finish by writing `.env.iranti` into known repo folders.' },
    { option: '--auto-remember [true|false]', meaning: 'Writes `IRANTI_AUTO_REMEMBER` into each project binding created during automated setup.', useWhen: 'you want project bindings to opt into strict prompt/summary auto-remember without hand-editing `.env.iranti` later.' },
    { option: '--claude-code', meaning: 'Also scaffold Claude Code MCP and hook files for bound projects during non-interactive setup.', useWhen: 'you want setup to leave each bound project immediately ready for Claude Code.' },
    { option: '--bootstrap-db', meaning: 'Runs migrations and seed steps after configuration when the target database is suitable.', useWhen: 'you want the database initialized right away and you know the target is a fresh or compatible pgvector-backed PostgreSQL database.' },
];

export const UNINSTALL_HELP: HelpEntry[] = [
    {
        command: 'iranti uninstall [--scope user|system] [--root <path>] [--dry-run] [--yes] [--all] [--keep-data] [--keep-project-bindings] [--scan-root <dir[,dir2]>] [--json]',
        description: 'Remove the installed package and optionally remove runtime roots plus project integration files.',
        useWhen: 'you are intentionally cleaning up an Iranti install and want to choose between package-only removal and a full wipe.',
        scenario: 'Removing the CLI from a machine while keeping project bindings, or doing a clean reinstall with `--all`.',
    },
];

export const UNINSTALL_OPTION_GUIDE: OptionGuideEntry[] = [
    { option: '--dry-run', meaning: 'Shows what would be removed without deleting anything.', useWhen: 'you want to review the uninstall plan before confirming it.' },
    { option: '--all', meaning: 'Also remove discovered runtime roots and project integration artifacts.', useWhen: 'you want a full cleanup instead of leaving instance data and bindings behind.' },
    { option: '--keep-data', meaning: 'Preserve runtime roots even when `--all` is selected.', useWhen: 'you need a fresh package install later but want to keep the instance data on disk.' },
    { option: '--keep-project-bindings', meaning: 'Preserve `.env.iranti` and related project integration files.', useWhen: 'projects should remain bound even though the CLI package is being removed.' },
    { option: '--scan-root <dir[,dir2]>', meaning: 'Controls where the CLI looks for project bindings and isolated runtime roots.', useWhen: 'your repos live outside the usual home directory or you want a narrower cleanup scan.' },
];

export const INSTANCE_HELP: HelpEntry[] = [
    {
        command: 'iranti instance create <name> [--port 3001] [--db-url <url>] [--api-key <token>] [--provider <name>] [--provider-key <token>] [--scope user|system] [--root <path>]',
        description: 'Create one named instance under the active runtime root.',
        useWhen: 'you want a scriptable primitive instead of the setup wizard.',
        scenario: 'Creating `staging` next to `local` inside a shared runtime root.',
    },
    {
        command: 'iranti instance list [--scope user|system] [--root <path>]',
        description: 'List instance directories under the active runtime root.',
        useWhen: 'you need to discover what instances exist before managing them.',
        scenario: 'Checking whether the runtime root contains `local`, `demo`, or `shared_team`.',
    },
    {
        command: 'iranti instance show <name> [--scope user|system] [--root <path>]',
        description: 'Show one instance configuration and runtime state.',
        useWhen: 'you are troubleshooting one named instance and need its exact port, env file, and status.',
        scenario: 'Comparing the bound instance env with the runtime you think is running.',
    },
    {
        command: 'iranti instance restart <name> [--scope user|system] [--root <path>] [--graceful-timeout <seconds>]',
        description: 'Restart one running instance using runtime metadata.',
        useWhen: 'you changed configuration or upgraded Iranti and need the process to pick it up.',
        scenario: 'Restarting `local` after changing `LLM_PROVIDER` from `mock` to `openai`.',
    },
];

export const CONFIGURE_HELP: HelpEntry[] = [
    {
        command: 'iranti configure instance <name> [--interactive] [--db-url <url>] [--port <n>] [--api-key <token>] [--provider <name>] [--provider-key <token>] [--clear-provider-key] [--scope user|system] [--root <path>] [--json]',
        description: 'Update one existing instance in place.',
        useWhen: 'you are changing a running or configured instance rather than creating a new one.',
        scenario: 'Updating the database URL, port, provider, or provider key for `local`.',
    },
    {
        command: 'iranti configure project [path] [--interactive] [--instance <name>] [--url <http://host:port>] [--api-key <token>] [--agent-id <id>] [--memory-entity <entity>] [--auto-remember [true|false]] [--mode isolated|shared] [--scope user|system] [--root <path>] [--json]',
        description: 'Update one existing project binding.',
        useWhen: 'the project already has `.env.iranti` and should be retargeted or corrected.',
        scenario: 'Rebinding a repo from one instance to another or correcting the agent identity.',
    },
];

export const AUTH_HELP: HelpEntry[] = [
    {
        command: 'iranti auth create-key --instance <name> --key-id <id> --owner <owner> [--scopes ...] [--description <text>] [--write-instance] [--project <path>] [--agent-id <id>] [--scope user|system] [--root <path>] [--json]',
        description: 'Create or rotate an Iranti client key.',
        useWhen: 'an app, project, or operator needs a durable authenticated credential for the Iranti API.',
        scenario: 'Issuing a new key for `iranti-control-plane` or rotating a leaked key ID.',
    },
    {
        command: 'iranti auth list-keys --instance <name> [--scope user|system] [--root <path>] [--json]',
        description: 'List registry-backed Iranti client keys.',
        useWhen: 'you need to inspect the existing auth surface before creating or revoking anything.',
        scenario: 'Auditing what keys exist for an instance before onboarding another project.',
    },
    {
        command: 'iranti auth revoke-key --instance <name> --key-id <id> [--scope user|system] [--root <path>] [--json]',
        description: 'Revoke an Iranti client key.',
        useWhen: 'a credential should stop working now because it is obsolete or compromised.',
        scenario: 'Removing access for a retired integration or suspected leaked token.',
    },
];

export const INTEGRATE_HELP: HelpEntry[] = [
    {
        command: 'iranti integrate claude [path] [--project-env <path>] [--force]',
        description: 'Alias for project-local Claude Code setup.',
        useWhen: 'you want the integration verb instead of the dedicated `claude-setup` command name.',
        scenario: 'Scaffolding one repo for Claude Code using the integration command group.',
    },
    {
        command: 'iranti integrate claude --scan <dir> [--recursive] [--force]',
        description: 'Alias for batch Claude Code setup.',
        useWhen: 'you want to scan a directory tree for Claude-enabled repos and scaffold them in one pass.',
        scenario: 'Applying Claude scaffolding across multiple repos under `Projects`.',
    },
    {
        command: 'iranti integrate codex [--name iranti] [--agent codex_code] [--source Codex] [--provider openai] [--project-env <path>] [--local-script] [--no-workspace-file]',
        description: 'Alias for Codex MCP setup.',
        useWhen: 'you want Codex integration but prefer the integration command group naming.',
        scenario: 'Registering Iranti with the global Codex MCP config.',
    },
];

export const PROVIDER_KEY_HELP: HelpEntry[] = [
    {
        command: 'iranti list api-keys [--instance <name>] [--project <path>] [--json]',
        description: 'List stored upstream provider keys.',
        useWhen: 'you need to see which remote providers are already configured.',
        scenario: 'Checking whether `openai` already has a stored key before adding or rotating one.',
    },
    {
        command: 'iranti add api-key [provider] [--instance <name>] [--project <path>] [--key <token>] [--set-default] [--json]',
        description: 'Add a new upstream provider key.',
        useWhen: 'a provider is not configured yet and should become available to the instance or project.',
        scenario: 'Adding a Claude key to an instance that was previously running on `mock` only.',
    },
    {
        command: 'iranti update api-key [provider] [--instance <name>] [--project <path>] [--key <token>] [--set-default] [--json]',
        description: 'Replace an existing provider key.',
        useWhen: 'the provider remains the same but the token changed.',
        scenario: 'Rotating an expired OpenAI key without changing the rest of the instance configuration.',
    },
    {
        command: 'iranti remove api-key [provider] [--instance <name>] [--project <path>] [--json]',
        description: 'Delete a stored provider key.',
        useWhen: 'a provider should no longer be usable from this instance or bound project.',
        scenario: 'Removing a Gemini credential after standardizing on another provider.',
    },
];

export const COMMON_FLOWS = {
    firstInstall: [
        'iranti setup',
        'iranti run --instance local',
        'iranti doctor --instance local',
    ],
    bindProject: [
        'iranti project init . --instance local',
        'iranti claude-setup .',
    ],
    workWithKeys: [
        'iranti auth create-key --instance local --key-id app_main --owner "App Main" --scopes "kb:read,kb:write,memory:read,memory:write"',
        'iranti add api-key openai --instance local --set-default',
    ],
};
