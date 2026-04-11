/**
 * Docker CLI output parsers.
 *
 * Lightweight, regex-based parsers for Docker CLI output strings.
 * Used when Iranti reads `docker ps` / `docker inspect` output and needs to
 * extract published host ports or container names without shelling out again.
 *
 * Key exports:
 *   - parsePublishedDockerHostPorts()  — extract host port numbers from `docker ps` port column
 *   - parseDockerContainerNames()      — split newline-delimited container name output into an array
 */

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
