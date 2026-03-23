export function parsePublishedDockerHostPorts(output: string): Set<number> {
    const ports = new Set<number>();
    for (const line of output.split(/\r?\n/)) {
        for (const match of line.matchAll(/(?:^|,\s*)(?:0\.0\.0\.0|127\.0\.0\.1|\[::\]|localhost):(\d+)->/g)) {
            const parsed = Number.parseInt(match[1] ?? '', 10);
            if (Number.isFinite(parsed) && parsed > 0) {
                ports.add(parsed);
            }
        }
    }
    return ports;
}

export function parseDockerContainerNames(output: string): string[] {
    return output
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
}
