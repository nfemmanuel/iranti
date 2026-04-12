/**
 * Package root resolver for the Iranti CLI.
 *
 * Walks up the directory tree from a given starting directory until it finds
 * a directory containing package.json, which is treated as the package root.
 * Depth is capped at 6 ancestors to avoid runaway traversal in edge cases.
 *
 * Key export:
 *   - resolvePackageRoot()  — find the nearest package.json ancestor directory
 */

import fs from 'fs';
import path from 'path';

export function resolvePackageRoot(startDir: string, maxDepth: number = 6): string | null {
    let dir = path.resolve(startDir);
    for (let i = 0; i < maxDepth; i += 1) {
        if (fs.existsSync(path.join(dir, 'package.json'))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}
