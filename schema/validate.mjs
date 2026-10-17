// Validate tangos.json descriptors against schema/tangos.schema.json.
//
// Usage: node schema/validate.mjs <descriptor path or URL> [...more]
//        node schema/validate.mjs --drift          (only the schema/types/validator drift check)
//
// Exits non-zero if the schema itself does not compile, the schema and the code that reads it
// have drifted apart, or any descriptor fails.
//
// The drift check runs every time. It reads three files that must describe the same fields and
// compares them by name: schema/tangos.schema.json (what a descriptor may say),
// console/src/shared/types.ts (what the Console's types allow) and console/src/main/descriptor.ts
// (the Console roles its structural validator accepts). A field added to one and not the others
// fails here, in CI, instead of being accepted by the schema and silently ignored by the app.
// CI runs this over the published reference descriptors so the schema and the
// dialect the Console consumes (console/src/shared/types.ts) cannot drift apart
// silently again.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'

const here = dirname(fileURLToPath(import.meta.url))
const schema = JSON.parse(readFileSync(join(here, 'tangos.schema.json'), 'utf8'))

const ajv = new Ajv2020.default({ allErrors: true })
const validate = ajv.compile(schema)

// ---- drift: schema <-> console/src/shared/types.ts <-> console/src/main/descriptor.ts ----
const typesSrc = readFileSync(join(here, '..', 'console', 'src', 'shared', 'types.ts'), 'utf8')
const descriptorSrc = readFileSync(join(here, '..', 'console', 'src', 'main', 'descriptor.ts'), 'utf8')

/** Property names of `export interface <name> { ... }`: the 2-space-indented `key?: type` lines. */
function interfaceKeys(name) {
  const m = new RegExp(`export interface ${name}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm').exec(typesSrc)
  if (!m) return null
  const keys = new Set()
  for (const line of m[1].split(/\r?\n/)) {
    const k = /^ {2}(\w+)\??:/.exec(line)
    if (k) keys.add(k[1])
  }
  return keys
}

/** [interface in types.ts, schema object whose `properties` it mirrors, label] */
const MIRRORS = [
  ['TangosArg', schema.$defs.arg, '$defs.arg'],
  ['TangosTool', schema.$defs.tool, '$defs.tool'],
  ['TangosCategory', schema.properties.categories.items, 'categories[]'],
  ['TangosProject', schema.properties.project, 'project'],
  ['TangosMatchConventions', schema.properties.project.properties.matchConventions, 'project.matchConventions'],
  ['TangosGate', schema.properties.project.properties.gates.items, 'project.gates[]'],
  ['TangosRuntime', schema.properties.runtime, 'runtime'],
  ['TangosRequirements', schema.properties.requirements, 'requirements'],
  ['TangosData', schema.properties.data, 'data'],
  ['TangosConsoleRoles', schema.properties.console, 'console']
]

function driftProblems() {
  const problems = []
  for (const [iface, node, label] of MIRRORS) {
    const keys = interfaceKeys(iface)
    if (!keys) {
      problems.push(`types.ts has no interface ${iface} (mirrors schema ${label})`)
      continue
    }
    const fields = new Set(Object.keys(node.properties ?? {}))
    for (const k of fields) if (!keys.has(k)) problems.push(`schema ${label}.${k} is missing from ${iface} in types.ts`)
    for (const k of keys) if (!fields.has(k)) problems.push(`${iface}.${k} in types.ts is missing from schema ${label}`)
  }
  // The roles descriptor.ts accepts for `console.<role>` are the schema's console properties.
  const roles = /const CONSOLE_ROLES = new Set\(\[([\s\S]*?)\]\)/.exec(descriptorSrc)
  if (!roles) problems.push('descriptor.ts has no CONSOLE_ROLES set')
  else {
    const accepted = new Set([...roles[1].matchAll(/'([^']+)'/g)].map((x) => x[1]))
    const declared = new Set(Object.keys(schema.properties.console.properties))
    for (const k of declared) if (!accepted.has(k)) problems.push(`schema console.${k} is missing from CONSOLE_ROLES in descriptor.ts`)
    for (const k of accepted) if (!declared.has(k)) problems.push(`CONSOLE_ROLES.${k} in descriptor.ts is missing from schema console`)
  }
  return problems
}

const drift = driftProblems()
if (drift.length) {
  console.error('FAIL schema/types/validator drift:')
  for (const p of drift) console.error(`  ${p}`)
} else {
  console.log('ok   schema, types.ts and descriptor.ts agree on every field')
}

const targets = process.argv.slice(2).filter((a) => a !== '--drift')
if (targets.length === 0) {
  if (process.argv.includes('--drift')) process.exit(drift.length ? 1 : 0)
  console.error('usage: node schema/validate.mjs [--drift] <descriptor path or URL> [...more]')
  process.exit(2)
}

let failed = drift.length > 0
for (const target of targets) {
  let text
  try {
    if (/^https?:\/\//.test(target)) {
      const res = await fetch(target)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      text = await res.text()
    } else {
      text = readFileSync(target, 'utf8')
    }
  } catch (e) {
    console.error(`FAIL ${target}: could not read (${e.message})`)
    failed = true
    continue
  }
  let doc
  try {
    doc = JSON.parse(text)
  } catch (e) {
    console.error(`FAIL ${target}: not valid JSON (${e.message})`)
    failed = true
    continue
  }
  if (validate(doc)) {
    console.log(`ok   ${target}`)
  } else {
    failed = true
    console.error(`FAIL ${target}:`)
    for (const err of validate.errors) {
      console.error(`  ${err.instancePath || '/'} ${err.message}`)
    }
  }
}
process.exit(failed ? 1 : 0)
