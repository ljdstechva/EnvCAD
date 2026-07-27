import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pngToIco from 'png-to-ico'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'public', 'icon-512.png')
const outputDirectory = path.join(root, 'desktop', 'assets')
const output = path.join(outputDirectory, 'envcad.ico')

await mkdir(outputDirectory, { recursive: true })
await writeFile(output, await pngToIco(source, { interpolation: 'bicubicInterpolation' }))
console.log(`Created ${path.relative(root, output)} from ${path.relative(root, source)}`)
