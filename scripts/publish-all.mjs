// Publishes the @listam/* workspace packages to npm in dependency order
// (leaves first), --access public, skipping any version already on the
// registry so the script is safe to re-run. Auth comes from a local .npmrc
// (gitignored). Pass --dry-run to validate tarballs without publishing.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DRY_RUN = process.argv.includes('--dry-run')

// npm only reads a project .npmrc from the *current* directory, not parents.
// Since we publish from each package subdir, point every npm call at the
// repo-root .npmrc (which holds the gitignored auth token) explicitly.
const NPM_ENV = { ...process.env, npm_config_userconfig: join(ROOT, '.npmrc') }

// Dependency order: leaves, then client (→protocol), then backend.
const ORDER = [
    'protocol', 'domain', 'logging', 'secrets', 'grocery', 'i18n', 'owner-control', 'provisioning',
    'client',
    'backend',
]

function pkgMeta(dir) {
    return JSON.parse(readFileSync(join(ROOT, 'packages', dir, 'package.json'), 'utf8'))
}

function publishedVersion(name) {
    try {
        return execFileSync('npm', ['view', `${name}`, 'version'], { encoding: 'utf8', env: NPM_ENV }).trim()
    } catch {
        return null
    }
}

for (const dir of ORDER) {
    const meta = pkgMeta(dir)
    const onRegistry = publishedVersion(meta.name)
    if (onRegistry === meta.version) {
        console.log(`= ${meta.name}@${meta.version} already published, skipping`)
        continue
    }
    const args = ['publish', '--access', 'public']
    if (DRY_RUN) args.push('--dry-run')
    console.log(`${DRY_RUN ? '[dry-run] ' : ''}publishing ${meta.name}@${meta.version} ...`)
    execFileSync('npm', args, { cwd: join(ROOT, 'packages', dir), stdio: 'inherit', env: NPM_ENV })
}

console.log(DRY_RUN ? '\nDry run complete.' : '\nAll packages published.')
