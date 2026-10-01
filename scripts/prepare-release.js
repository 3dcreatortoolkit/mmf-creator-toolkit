import {appendFile, readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export function nextReleaseVersion(baseVersion, runNumber) {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(baseVersion);
    const run = Number(runNumber);
    if (!match || !Number.isSafeInteger(run) || run < 1) {
        throw new Error('A three-part base version and a positive GITHUB_RUN_NUMBER are required.');
    }
    const patch = Number(match[3]) + run - 1;
    if (patch > 65535) throw new Error('The patch version exceeds the Chrome extension manifest limit.');
    return `${match[1]}.${match[2]}.${patch}`;
}

export async function prepareRelease(runNumber = process.env.GITHUB_RUN_NUMBER) {
    const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
    const pkg = JSON.parse(await readFile('package.json', 'utf8'));
    const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
    if (manifest.version !== pkg.version || pkg.version !== lock.version ||
        lock.packages?.['']?.version !== pkg.version) {
        throw new Error('Manifest, package, and lockfile base versions must agree.');
    }
    const version = nextReleaseVersion(pkg.version, runNumber);
    if (version !== pkg.version) {
        manifest.version = version;
        pkg.version = version;
        lock.version = version;
        lock.packages[''].version = version;
        await Promise.all([
            writeFile('extension/manifest.json', `${JSON.stringify(manifest, null, 2)}\n`),
            writeFile('package.json', `${JSON.stringify(pkg, null, 2)}\n`),
            writeFile('package-lock.json', `${JSON.stringify(lock, null, 2)}\n`),
        ]);
    }
    if (process.env.GITHUB_OUTPUT) {
        await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\ntag=v${version}\n`);
    }
    console.log(`Prepared extension release v${version}`);
    return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    await prepareRelease();
}
