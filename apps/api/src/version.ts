import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string };
export const versionInfo = Object.freeze({ version: manifest.version, revision: process.env.BUILD_REVISION ?? 'unknown' });
