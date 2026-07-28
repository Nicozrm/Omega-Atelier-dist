/**
 * sync-media.mjs — bring the shared media into `app/public/` before a build.
 *
 * The GLB models, the PBR textures and the promo video are ~27 MB and are
 * already committed once, at the repository root, because that root *is* the
 * deployed site. Committing a second copy under `app/public/` just to satisfy
 * the dev server would double the repository for no benefit, so instead this
 * script copies them in on demand. `app/.gitignore` keeps the copies untracked.
 *
 * Runs automatically via the `predev` / `prebuild` npm hooks; it is idempotent
 * and skips files that are already present and the same size.
 */

import { cp, mkdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(here, '..')
const repoRoot = resolve(appDir, '..')
const publicDir = join(appDir, 'public')

/** Directories and files copied from the repository root into `public/`. */
const ENTRIES = [
  'models',
  'textures',
  'omega-promo.mp4',
  'omega-promo.webm',
  'omega-promo-poster.png',
]

async function sameSize(a, b) {
  try {
    const [x, y] = await Promise.all([stat(a), stat(b)])
    return x.isFile() && y.isFile() && x.size === y.size
  } catch {
    return false
  }
}

await mkdir(publicDir, { recursive: true })

for (const entry of ENTRIES) {
  const from = join(repoRoot, entry)
  const to = join(publicDir, entry)
  if (!existsSync(from)) {
    console.warn(`[sync-media] missing at repo root, skipped: ${entry}`)
    continue
  }
  if (await sameSize(from, to)) continue
  await cp(from, to, { recursive: true, force: true })
  console.log(`[sync-media] ${entry}`)
}
