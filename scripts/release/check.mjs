import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = path => readFileSync(path,'utf8');
const { version } = JSON.parse(read('package.json'));
assert.match(version,/^\d+\.\d+\.\d+$/);
for (const field of ['version','appVersion']) {
 const match=read('deploy/helm/dnsmonitor/Chart.yaml').match(new RegExp(`^${field}:\\s*"?([^"\\s]+)`, 'm'));
 assert.equal(match?.[1],version,`Chart ${field} differs from package.json`);
}
assert.ok(read('Dockerfile').includes(`org.opencontainers.image.version="${version}"`),'Image label must match package version');
assert.ok(read('CHANGELOG.md').includes(`## ${version} `),'Missing changelog entry');
if(process.env.RELEASE_TAG) assert.equal(process.env.RELEASE_TAG,`v${version}`,'Release tag must match package version');
console.log(`Release metadata consistent: v${version}`);
