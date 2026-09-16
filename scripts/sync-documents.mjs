/**
 * Mirrors legalx-web/lib/documents.ts into the backend.
 *
 * The service catalogue is static data with no imports, and three clients now
 * need it: the website reads it directly, and the mobile app and any future
 * client read it over /api/services. Copying it mechanically is the only way
 * two copies stay identical — hand-editing one of them is how they drift.
 *
 * Run: node scripts/sync-documents.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = resolve(here, '../../legalx-web/lib/documents.ts')
const target = resolve(here, '../src/lib/documents.ts')

const banner = `// GENERATED FILE — do not edit.
// Mirror of legalx-web/lib/documents.ts, copied by scripts/sync-documents.mjs.
// Edit the web copy, then re-run the script.

`

writeFileSync(target, banner + readFileSync(source, 'utf8'))
console.log(`documents.ts synced (${readFileSync(target, 'utf8').split('\n').length} lines)`)
