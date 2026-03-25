function normalizeErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

export function rewriteCommandError(commandLabel: string, error: unknown): Error {
    const message = normalizeErrorMessage(error);
    if (
        /does not exist in the current database/i.test(message)
        || /relation .* does not exist/i.test(message)
        || /column .* does not exist/i.test(message)
        || /table .* does not exist/i.test(message)
    ) {
        return new Error(
            `${commandLabel} cannot run because the database schema is behind the current Iranti code. `
            + `${message} Apply migrations with \`npx prisma migrate deploy --schema prisma/schema.prisma\` `
            + 'and regenerate the Prisma client with `npm run prisma:generate`.'
        );
    }

    return error instanceof Error ? error : new Error(message);
}
