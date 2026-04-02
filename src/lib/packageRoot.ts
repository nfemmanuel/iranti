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
