import { createHash, type Hash } from 'node:crypto'
import {
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  truncate,
  type FileHandle
} from 'node:fs/promises'
import path from 'node:path'
import {
  MAX_INPUT_ARTIFACT_BYTES,
  MAX_INPUT_CHUNK_BYTES,
  MAX_INPUT_CHUNKS,
  inputReferenceSchema,
  type InputChunkReference,
  type InputIngestionCommand,
  type InputReference
} from '../../../../shared/agent-contracts'
import { readInputJson, writeDurableInputJson } from './DurableInputJson'
import {
  inputArtifactPaths,
  isTextMediaType,
  MAX_INPUT_CLASSIFICATION_CHARACTERS,
  parseStagedInputArtifact,
  parseStoredInputArtifact,
  type StagedInputArtifact,
  type StoredInputArtifact
} from './InputStoreMetadata'

const DEFAULT_QUOTA_BYTES = 1024 * 1024 * 1024
const DEFAULT_FREE_SPACE_RESERVE_BYTES = 32 * 1024 * 1024

interface ActiveInputUpload {
  state: StagedInputArtifact
  handle: FileHandle
  hash: Hash
  decoder?: TextDecoder
  reservationBytes: number
}

export interface LocalInputStoreOptions {
  quotaBytes?: number
  freeSpaceReserveBytes?: number
  now?: () => Date
}

export interface InputBeginResult {
  receivedBytes: number
  receivedChunks: number
  committed?: InputReference
}

export class LocalInputStore {
  private readonly uploads = new Map<string, ActiveInputUpload>()
  private readonly quotaBytes: number
  private readonly freeSpaceReserveBytes: number
  private readonly now: () => Date
  private initialization: Promise<void> | undefined
  private committedBytes = 0
  private reservedBytes = 0

  constructor(
    readonly rootDirectory: string,
    options: LocalInputStoreOptions = {}
  ) {
    this.quotaBytes = options.quotaBytes ?? DEFAULT_QUOTA_BYTES
    this.freeSpaceReserveBytes =
      options.freeSpaceReserveBytes ?? DEFAULT_FREE_SPACE_RESERVE_BYTES
    this.now = options.now ?? (() => new Date())
  }

  async begin(
    command: Extract<InputIngestionCommand, { type: 'input_begin' }>
  ): Promise<InputBeginResult> {
    await this.initialize()
    const committed = await this.tryMetadata(command.inputId)
    if (committed) {
      return {
        receivedBytes: committed.reference.byteLength,
        receivedChunks: committed.reference.chunkCount,
        committed: committed.reference
      }
    }
    const current = this.uploads.get(command.inputId)
    if (current) {
      this.assertSameBegin(current.state, command)
      return this.progress(current)
    }
    const resumed = await this.tryResume(command)
    if (resumed) {
      this.uploads.set(command.inputId, resumed)
      this.reservedBytes += resumed.reservationBytes
      return this.progress(resumed)
    }
    const reservation =
      command.declaredByteLength ?? MAX_INPUT_ARTIFACT_BYTES
    await this.assertCapacity(reservation)
    const paths = inputArtifactPaths(this.rootDirectory, command.inputId)
    await mkdir(paths.stagedDirectory, { recursive: false })
    const handle = await open(paths.stagedData, 'wx+')
    const state: StagedInputArtifact = {
      inputId: command.inputId,
      mediaType: command.mediaType,
      ...(command.sourceName ? { sourceName: command.sourceName } : {}),
      ...(command.declaredByteLength !== undefined
        ? { declaredByteLength: command.declaredByteLength }
        : {}),
      receivedBytes: 0,
      chunks: [],
      ...(isTextMediaType(command.mediaType)
        ? {
            textEncoding: 'utf-8' as const,
            characterLength: 0,
            classificationText: ''
          }
        : {})
    }
    await writeDurableInputJson(paths.stagedState, state)
    const upload = this.createUpload(state, handle, reservation)
    this.uploads.set(command.inputId, upload)
    this.reservedBytes += reservation
    return this.progress(upload)
  }

  async append(
    command: Extract<InputIngestionCommand, { type: 'input_chunk' }>
  ): Promise<InputBeginResult> {
    const upload = this.requireUpload(command.inputId)
    const bytes = Buffer.from(command.bytesBase64, 'base64')
    if (bytes.length === 0 || bytes.length > MAX_INPUT_CHUNK_BYTES) {
      throw new Error('Input chunk byte length is outside the allowed range.')
    }
    if (
      command.chunkIndex !== upload.state.chunks.length ||
      command.chunkIndex >= MAX_INPUT_CHUNKS
    ) {
      throw new Error(
        `Input chunk index ${command.chunkIndex} is not the next expected index ${upload.state.chunks.length}.`
      )
    }
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== command.sha256) {
      throw new Error('Input chunk digest does not match its decoded bytes.')
    }
    const byteEnd = upload.state.receivedBytes + bytes.length
    if (
      byteEnd > MAX_INPUT_ARTIFACT_BYTES ||
      (upload.state.declaredByteLength !== undefined &&
        byteEnd > upload.state.declaredByteLength)
    ) {
      throw new Error('Input chunks exceed the declared or maximum artifact size.')
    }
    const characterStart = upload.state.characterLength
    const decoded = upload.decoder?.decode(bytes, { stream: true })
    appendClassificationText(upload.state, decoded)
    const characterEnd =
      characterStart === undefined
        ? undefined
        : characterStart + countCodePoints(decoded ?? '')
    const written = await upload.handle.write(
      bytes,
      0,
      bytes.length,
      upload.state.receivedBytes
    )
    if (written.bytesWritten !== bytes.length) {
      throw new Error('The local content store wrote an incomplete input chunk.')
    }
    await upload.handle.sync()
    upload.hash.update(bytes)
    const reference: InputChunkReference = {
      inputId: command.inputId,
      chunkIndex: command.chunkIndex,
      byteStart: upload.state.receivedBytes,
      byteEnd,
      ...(characterStart !== undefined && characterEnd !== undefined
        ? { characterStart, characterEnd }
        : {}),
      sha256: digest
    }
    upload.state.receivedBytes = byteEnd
    upload.state.characterLength = characterEnd
    upload.state.chunks.push(reference)
    await this.persistUpload(upload)
    return this.progress(upload)
  }

  async commit(
    command: Extract<InputIngestionCommand, { type: 'input_commit' }>
  ): Promise<InputReference> {
    const existing = await this.tryMetadata(command.inputId)
    if (existing) {
      if (existing.reference.sha256 !== command.sha256) {
        throw new Error('Committed input id has a different complete digest.')
      }
      return existing.reference
    }
    const upload = this.requireUpload(command.inputId)
    try {
      const tail = upload.decoder?.decode() ?? ''
      appendClassificationText(upload.state, tail)
      if (tail && upload.state.characterLength !== undefined) {
        upload.state.characterLength += countCodePoints(tail)
        const finalChunk = upload.state.chunks.at(-1)
        if (finalChunk) finalChunk.characterEnd = upload.state.characterLength
      }
      if (
        upload.state.declaredByteLength !== undefined &&
        upload.state.receivedBytes !== upload.state.declaredByteLength
      ) {
        throw new Error('Committed input length does not match its declaration.')
      }
      const digest = upload.hash.digest('hex')
      if (digest !== command.sha256) {
        await this.discardUpload(upload)
        throw new Error('Complete input digest does not match the ingested bytes.')
      }
      await upload.handle.sync()
      await upload.handle.close()
      const reference = inputReferenceSchema.parse({
        inputId: upload.state.inputId,
        sha256: digest,
        mediaType: upload.state.mediaType,
        byteLength: upload.state.receivedBytes,
        ...(upload.state.characterLength !== undefined
          ? { characterLength: upload.state.characterLength }
          : {}),
        chunkCount: upload.state.chunks.length,
        ...(upload.state.sourceName
          ? { sourceName: upload.state.sourceName }
          : {})
      })
      const artifact: StoredInputArtifact = {
        reference,
        chunks: upload.state.chunks.map((chunk) => ({ ...chunk })),
        ...(upload.state.textEncoding
          ? { textEncoding: upload.state.textEncoding }
          : {}),
        ...(upload.state.classificationText
          ? { classificationText: upload.state.classificationText }
          : {}),
        committedAt: this.now().toISOString()
      }
      const paths = inputArtifactPaths(this.rootDirectory, command.inputId)
      await writeDurableInputJson(paths.stagedMetadata, artifact)
      await rename(paths.stagedDirectory, paths.committedDirectory)
      await rm(path.join(paths.committedDirectory, 'state.json'), {
        force: true
      })
      this.finishReservation(upload)
      this.committedBytes += reference.byteLength
      this.uploads.delete(command.inputId)
      return reference
    } catch (error) {
      if (upload.handle.fd !== -1) await upload.handle.sync().catch(() => {})
      throw error
    }
  }

  async abort(inputId: string): Promise<void> {
    await this.initialize()
    const upload = this.uploads.get(inputId)
    if (upload) {
      await upload.handle.close().catch(() => {})
      this.finishReservation(upload)
      this.uploads.delete(inputId)
    }
    const paths = inputArtifactPaths(this.rootDirectory, inputId)
    await rm(paths.stagedDirectory, { recursive: true, force: true })
    const committed = await this.tryMetadata(inputId)
    if (committed) {
      await rm(paths.committedDirectory, { recursive: true, force: true })
      this.committedBytes = Math.max(
        0,
        this.committedBytes - committed.reference.byteLength
      )
    }
  }

  async close(): Promise<void> {
    for (const upload of this.uploads.values()) {
      await upload.handle.close().catch(() => {})
    }
    this.uploads.clear()
    this.reservedBytes = 0
  }

  async metadata(inputId: string): Promise<StoredInputArtifact> {
    await this.initialize()
    const artifact = await this.tryMetadata(inputId)
    if (!artifact) throw new Error(`Input "${inputId}" is not committed locally.`)
    return artifact
  }

  private initialize(): Promise<void> {
    this.initialization ??= this.initializeStore()
    return this.initialization
  }

  private async initializeStore(): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true })
    await mkdir(path.join(this.rootDirectory, 'staging'), { recursive: true })
    const committedRoot = path.join(this.rootDirectory, 'committed')
    await mkdir(committedRoot, { recursive: true })
    const entries = await readdir(committedRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        const metadata = parseStoredInputArtifact(
          await readInputJson(path.join(committedRoot, entry.name, 'metadata.json'))
        )
        this.committedBytes += metadata.reference.byteLength
      } catch {
        // Corrupt artifacts remain quarantined and are never counted as readable.
      }
    }
  }

  private async tryMetadata(
    inputId: string
  ): Promise<StoredInputArtifact | undefined> {
    const paths = inputArtifactPaths(this.rootDirectory, inputId)
    try {
      const artifact = parseStoredInputArtifact(
        await readInputJson(paths.committedMetadata)
      )
      return artifact.reference.inputId === inputId ? artifact : undefined
    } catch {
      return undefined
    }
  }

  private async tryResume(
    command: Extract<InputIngestionCommand, { type: 'input_begin' }>
  ): Promise<ActiveInputUpload | undefined> {
    const paths = inputArtifactPaths(this.rootDirectory, command.inputId)
    try {
      const state = parseStagedInputArtifact(
        await readInputJson(paths.stagedState)
      )
      this.assertSameBegin(state, command)
      const file = await stat(paths.stagedData)
      if (file.size < state.receivedBytes) {
        throw new Error('Staged input is shorter than its durable chunk index.')
      }
      if (file.size > state.receivedBytes) {
        await truncate(paths.stagedData, state.receivedBytes)
      }
      const handle = await open(paths.stagedData, 'r+')
      const reservation =
        state.declaredByteLength ?? MAX_INPUT_ARTIFACT_BYTES
      await this.assertCapacity(reservation)
      const upload = this.createUpload(state, handle, reservation)
      await this.rehydrateDigest(upload)
      return upload
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private createUpload(
    state: StagedInputArtifact,
    handle: FileHandle,
    reservationBytes: number
  ): ActiveInputUpload {
    return {
      state,
      handle,
      hash: createHash('sha256'),
      ...(state.textEncoding
        ? { decoder: new TextDecoder('utf-8', { fatal: true }) }
        : {}),
      reservationBytes
    }
  }

  private async rehydrateDigest(upload: ActiveInputUpload): Promise<void> {
    let offset = 0
    const buffer = Buffer.allocUnsafe(MAX_INPUT_CHUNK_BYTES)
    while (offset < upload.state.receivedBytes) {
      const length = Math.min(buffer.length, upload.state.receivedBytes - offset)
      const read = await upload.handle.read(buffer, 0, length, offset)
      if (read.bytesRead !== length) {
        throw new Error('Could not reconstruct the staged input digest.')
      }
      const bytes = buffer.subarray(0, read.bytesRead)
      upload.hash.update(bytes)
      upload.decoder?.decode(bytes, { stream: true })
      offset += read.bytesRead
    }
  }

  private async persistUpload(upload: ActiveInputUpload): Promise<void> {
    const paths = inputArtifactPaths(
      this.rootDirectory,
      upload.state.inputId
    )
    await writeDurableInputJson(paths.stagedState, upload.state)
  }

  private async assertCapacity(reservation: number): Promise<void> {
    if (this.committedBytes + this.reservedBytes + reservation > this.quotaBytes) {
      throw new InputStoreCapacityError(
        'The local input quota cannot reserve this artifact.'
      )
    }
    const disk = await statfs(this.rootDirectory)
    const available = disk.bavail * disk.bsize
    if (available - this.freeSpaceReserveBytes < reservation) {
      throw new InputStoreCapacityError(
        'The local disk does not have enough safe free space for this artifact.'
      )
    }
  }

  private assertSameBegin(
    state: StagedInputArtifact,
    command: Extract<InputIngestionCommand, { type: 'input_begin' }>
  ): void {
    if (
      state.inputId !== command.inputId ||
      state.mediaType !== command.mediaType ||
      state.sourceName !== command.sourceName ||
      state.declaredByteLength !== command.declaredByteLength
    ) {
      throw new Error('Input id is already staged with different metadata.')
    }
  }

  private requireUpload(inputId: string): ActiveInputUpload {
    const upload = this.uploads.get(inputId)
    if (!upload) throw new Error(`Input "${inputId}" has not been begun.`)
    return upload
  }

  private progress(upload: ActiveInputUpload): InputBeginResult {
    return {
      receivedBytes: upload.state.receivedBytes,
      receivedChunks: upload.state.chunks.length
    }
  }

  private finishReservation(upload: ActiveInputUpload): void {
    this.reservedBytes = Math.max(
      0,
      this.reservedBytes - upload.reservationBytes
    )
  }

  private async discardUpload(upload: ActiveInputUpload): Promise<void> {
    await upload.handle.close().catch(() => {})
    this.finishReservation(upload)
    this.uploads.delete(upload.state.inputId)
    const paths = inputArtifactPaths(
      this.rootDirectory,
      upload.state.inputId
    )
    await rm(paths.stagedDirectory, { recursive: true, force: true })
  }
}

export class InputStoreCapacityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InputStoreCapacityError'
  }
}

function countCodePoints(value: string): number {
  return Array.from(value).length
}

function appendClassificationText(
  state: StagedInputArtifact,
  value: string | undefined
): void {
  if (!value || state.classificationText === undefined) return
  const remaining =
    MAX_INPUT_CLASSIFICATION_CHARACTERS -
    countCodePoints(state.classificationText)
  if (remaining <= 0) return
  state.classificationText += Array.from(value).slice(0, remaining).join('')
}
