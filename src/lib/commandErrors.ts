/**
 * CLI error rewriting for the Iranti CLI.
 *
 * Maps low-level errors (Prisma schema mismatches, ECONNREFUSED, missing flags)
 * to structured RewrittenCommandError values with human-readable messages and
 * actionable hint arrays. Each rule has a regex test and a builder; the first
 * matching rule wins. Errors already carrying an IRANTI_* code pass through
 * unchanged to preserve previously rewritten errors.
 *
 * Adding a new CLI error: append a new entry to REWRITE_RULES with a unique
 * IRANTI_* code, a test() function, and a build() function.
 *
 * Key exports:
 *   - rewriteCommandError()    — the main error transform used by every CLI command handler
 *   - RewrittenCommandError    — extended Error type with code and hints
 */

export type RewrittenCommandError = Error & {
    code?: string;
    hints?: string[];
};

type ErrorRewriteRule = {
    code: string;
    test: (message: string, rawCode: string) => boolean;
    build: (commandLabel: string, message: string) => { message: string; hints?: string[] };
};

function normalizeErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

function commandError(code: string, message: string, hints: string[] = []): RewrittenCommandError {
    return Object.assign(new Error(message), { code, hints });
}

const REWRITE_RULES: ErrorRewriteRule[] = [
    {
        code: 'IRANTI_DATABASE_SCHEMA_MISMATCH',
        test: (message) =>
            /does not exist in the current database/i.test(message)
            || /relation .* does not exist/i.test(message)
            || /column .* does not exist/i.test(message)
            || /table .* does not exist/i.test(message),
        build: (commandLabel, message) => ({
            message:
                `${commandLabel} cannot run because the database schema is behind the current Iranti code. `
                + `${message} Apply migrations with \`npx prisma migrate deploy --schema prisma/schema.prisma\` `
                + 'and regenerate the Prisma client with `npm run prisma:generate`.',
            hints: [
                'Run `npx prisma migrate deploy --schema prisma/schema.prisma`.',
                'Run `npm run prisma:generate` after migrations complete.',
            ],
        }),
    },
    {
        code: 'IRANTI_DATABASE_UNREACHABLE',
        test: (message, rawCode) =>
            rawCode === 'ECONNREFUSED'
            || rawCode === 'ETIMEDOUT'
            || /can\'t reach database server/i.test(message)
            || /database .* unreachable/i.test(message)
            || /connect ECONNREFUSED/i.test(message),
        build: (commandLabel) => ({
            message:
                `${commandLabel} cannot reach the configured PostgreSQL database. `
                + 'Verify that the database server is running, confirm `DATABASE_URL`, '
                + 'and rerun the command or use `iranti doctor --debug` for a deeper check.',
            hints: [
                'Verify that PostgreSQL is running and reachable from this machine.',
                'Confirm `DATABASE_URL` points at the intended instance.',
                'Use `iranti doctor --debug` for a deeper operator check.',
            ],
        }),
    },
    {
        code: 'IRANTI_SCOPE_INVALID',
        test: (message) => /^Invalid scope '.*'\. Use --scope user or --scope system\.$/i.test(message),
        build: () => ({
            message: 'Invalid scope. Use `--scope user` or `--scope system`.',
            hints: [
                'Retry with `--scope user` for the current user runtime root.',
                'Retry with `--scope system` for the shared machine runtime root.',
            ],
        }),
    },
    {
        code: 'IRANTI_BOOLEAN_VALUE_INVALID',
        test: (message) =>
            /must be true\/false, yes\/no, on\/off, or 1\/0\.$/i.test(message)
            || /must be a boolean or boolean-like string\.$/i.test(message),
        build: (_commandLabel, message) => ({
            message,
            hints: ['Use one of: `true`, `false`, `yes`, `no`, `on`, `off`, `1`, or `0`.'],
        }),
    },
    {
        code: 'IRANTI_INTEGER_VALUE_INVALID',
        test: (message) =>
            /must be a positive integer\.$/i.test(message)
            || /^Invalid --port '.*'\.$/i.test(message)
            || /^Invalid --docker-health-port '.*'\.$/i.test(message)
            || /^Invalid setup config port:/i.test(message),
        build: (_commandLabel, message) => ({
            message,
            hints: ['Use a positive integer value.'],
        }),
    },
    {
        code: 'IRANTI_INSTANCE_NAME_REQUIRED',
        test: (message) => /^Missing instance name\./i.test(message) || /^Missing --instance <name>\./i.test(message),
        build: (_commandLabel, message) => ({
            message,
            hints: ['Run `iranti instance list` to see configured instances.'],
        }),
    },
    {
        code: 'IRANTI_INSTANCE_EXISTS',
        test: (message) => /^Instance '.*' already exists at .*Use --force to overwrite\.$/i.test(message),
        build: (_commandLabel, message) => ({
            message,
            hints: ['Re-run with `--force` only if overwriting the existing instance is intentional.'],
        }),
    },
    {
        code: 'IRANTI_PROVIDER_KEY_UNSUPPORTED',
        test: (message) => /^Provider '.*' does not use a remote API key\.$/i.test(message),
        build: (_commandLabel, message) => ({
            message,
            hints: ['Remove `--provider-key` or choose a remote provider such as `openai`, `claude`, or `gemini`.'],
        }),
    },
    {
        code: 'IRANTI_PROJECT_BINDING_INPUT_REQUIRED',
        test: (message) =>
            /^Unable to determine IRANTI_URL\./i.test(message)
            || /^Unable to determine IRANTI_API_KEY\./i.test(message),
        build: (_commandLabel, message) => ({
            message,
            hints: [
                'Provide `--instance <name>` to derive the binding from a local instance.',
                'Or pass explicit `--url` and `--api-key` values.',
            ],
        }),
    },
    {
        code: 'IRANTI_CONFIGURE_NO_CHANGES',
        test: (message) => /^No changes provided\./i.test(message),
        build: (_commandLabel, message) => ({
            message,
            hints: ['Pass at least one update flag or use `--interactive` for guided repair.'],
        }),
    },
    {
        code: 'IRANTI_AUTH_ARGUMENTS_REQUIRED',
        test: (message) =>
            /^Missing --key-id or --owner\.$/i.test(message)
            || /^Missing --instance <name> or --key-id <id>\./i.test(message),
        build: (_commandLabel, message) => ({
            message,
            hints: ['Supply the required auth flags before retrying.'],
        }),
    },
    {
        code: 'IRANTI_INSTANCE_DATABASE_PLACEHOLDER',
        test: (message) => /still has a placeholder DATABASE_URL/i.test(message),
        build: (_commandLabel, message) => ({
            message,
            hints: [
                'Update the instance `.env` with a real PostgreSQL connection string.',
                'Use `iranti configure instance <name> --interactive` to repair the instance env.',
            ],
        }),
    },
    {
        code: 'IRANTI_API_KEY_NOT_FOUND',
        test: (message) => /^API key not found:/i.test(message),
        build: (_commandLabel, message) => ({
            message,
            hints: ['Run `iranti auth list-keys --instance <name>` to inspect the current registry keys.'],
        }),
    },
    {
        code: 'IRANTI_ATTEND_MESSAGE_REQUIRED',
        test: (message) => /^Missing latest message\./i.test(message),
        build: (_commandLabel, message) => ({
            message,
            hints: ['Pass the message positionally or with `--message <text>`.'],
        }),
    },
    {
        code: 'IRANTI_TASK_ENTITY_REQUIRED',
        test: (message) => /^Missing task entity\./i.test(message),
        build: (_commandLabel, message) => ({
            message,
            hints: ['Pass a task entity like `task/runtime_verification` before retrying.'],
        }),
    },
    {
        code: 'IRANTI_ISSUE_ENTITY_REQUIRED',
        test: (message) => /^Missing issue entity\./i.test(message),
        build: (_commandLabel, message) => ({
            message,
            hints: ['Pass `--entity <entityType/entityId>` or run from a bound project with `IRANTI_MEMORY_ENTITY`.'],
        }),
    },
    {
        code: 'IRANTI_ENTITY_FORMAT_INVALID',
        test: (message) =>
            /must use entityType\/entityId format\.$/i.test(message),
        build: (_commandLabel, message) => ({
            message,
            hints: ['Use the canonical `entityType/entityId` format such as `project/iranti`.'],
        }),
    },
    {
        code: 'IRANTI_ISSUE_STATUS_INVALID',
        test: (message) => /^Invalid --status '.*'\. Use open or resolved\.$/i.test(message),
        build: (_commandLabel, message) => ({
            message,
            hints: ['Use `--status open` or `--status resolved`.'],
        }),
    },
    {
        code: 'IRANTI_HANDOFF_NEXT_STEP_REQUIRED',
        test: (message) => /^Missing --next-step\./i.test(message),
        build: (_commandLabel, message) => ({
            message,
            hints: ['Pass `--next-step <text>` so the receiving agent has a concrete action.'],
        }),
    },
    {
        code: 'IRANTI_CONFIDENCE_INVALID',
        test: (message) => /^confidence must be <= 100\.$/i.test(message),
        build: (_commandLabel, message) => ({
            message,
            hints: ['Use an integer confidence between 1 and 100.'],
        }),
    },
    {
        code: 'IRANTI_PROJECT_MODE_INVALID',
        test: (message) => /^Invalid project mode '.*'\. Use isolated or shared\.$/i.test(message),
        build: (_commandLabel, message) => ({
            message,
            hints: ['Use `isolated` for one-project-per-instance or `shared` for intentional cross-project memory.'],
        }),
    },
    {
        code: 'IRANTI_DATABASE_INTENT_INVALID',
        test: (message) => /^Invalid --db-intent '.*'\. Use dedicated, shared, or external\.$/i.test(message),
        build: (_commandLabel, message) => ({
            message,
            hints: ['Use `dedicated`, `shared`, or `external`.'],
        }),
    },
    {
        code: 'IRANTI_DOCKER_DEPENDENCY_INVALID',
        test: (message) => /^--docker-health-port requires --docker-container <name>\.$/i.test(message),
        build: (_commandLabel, message) => ({
            message,
            hints: ['Pass `--docker-container <name>` together with `--docker-health-port <port>`.'],
        }),
    },
    {
        code: 'IRANTI_UNKNOWN_SUBCOMMAND',
        test: (message) =>
            /^Unknown instance subcommand /i.test(message)
            || /^Unknown configure subcommand /i.test(message)
            || /^Unknown auth subcommand /i.test(message)
            || /^Unknown integrate target /i.test(message),
        build: (_commandLabel, message) => ({
            message,
            hints: ['Run `iranti help` or `iranti <command> --help` to see the supported subcommands.'],
        }),
    },
];

export function rewriteCommandError(commandLabel: string, error: unknown): RewrittenCommandError {
    if (error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string') {
        const code = String((error as { code?: unknown }).code ?? '');
        if (
            error instanceof Error
            && code.startsWith('IRANTI_')
            && Array.isArray((error as RewrittenCommandError).hints)
        ) {
            return error as RewrittenCommandError;
        }
    }

    const message = normalizeErrorMessage(error);
    const rawCode = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : '';

    for (const rule of REWRITE_RULES) {
        if (rule.test(message, rawCode)) {
            const rewritten = rule.build(commandLabel, message);
            return commandError(rule.code, rewritten.message, rewritten.hints ?? []);
        }
    }

    if (error instanceof Error) {
        return Object.assign(error, { code: rawCode || 'IRANTI_COMMAND_FAILED', hints: [] as string[] });
    }

    return commandError('IRANTI_COMMAND_FAILED', message, []);
}
