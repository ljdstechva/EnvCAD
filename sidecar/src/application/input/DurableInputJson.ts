import { randomUUID } from 'node:crypto'
import { open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'

export async function readInputJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf8')) as unknown
}

export async function writeDurableInputJson(
  filePath: string,
  value: unknown
): Promise<void> {
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`
  )
  const handle = await open(temporary, 'wx')
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, filePath)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}
