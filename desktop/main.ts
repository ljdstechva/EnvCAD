import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  safeStorage,
  session,
  shell,
  utilityProcess,
  type IpcMainInvokeEvent
} from 'electron'
import log from 'electron-log/main'
import { startFrontendServer, type FrontendServerHandle } from './frontendServer'
import {
  DESKTOP_IPC,
  isDurableAgentStateKey,
  type DesktopRuntimeConfig,
  type SidecarStatus
} from './runtimeProtocol'
import { SidecarProcess, type UtilityProcessLike } from './sidecarProcess'
import { AiPreferencesStore } from './aiPreferences'
import { SheetPreferencesStore } from './sheetPreferences'
import { handleSquirrelStartup } from './squirrelStartup'
import { focusExistingWindow } from './windowLifecycle'
import { removeRuntimeDirectoryWithRetry } from './runtimeDirectoryCleanup'
import { removeLegacyEnvCadClaudeTranscripts } from './claudeTranscriptCleanup'
import { PersistentOperationLedger } from './agentJournal/PersistentOperationLedger'
import { PersistentOperationResultStore } from './agentJournal/PersistentOperationResultStore'
import { reconcileAbandonedOperations } from './agentJournal/AbandonedOperationReconciler'
import { PersistentTurnJournal } from './agentJournal/PersistentTurnJournal'
import { reconcileAbandonedTurns } from './agentJournal/AbandonedTurnReconciler'
import { installOperationJournalIpc } from './operationJournalIpc'
import { PersistentRendererAgentState } from './agentJournal/PersistentRendererAgentState'

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined

const APP_ID = 'com.ljdstechva.envcad'
const started = handleSquirrelStartup()
const startupStartedAt = performance.now()
const sessionToken = randomBytes(32).toString('base64url')
let mainWindow: BrowserWindow | null = null
let frontendServer: FrontendServerHandle | undefined
let sidecarProcess: SidecarProcess | undefined
let aiPreferencesStore: AiPreferencesStore | undefined
let sheetPreferencesStore: SheetPreferencesStore | undefined
let operationLedger: PersistentOperationLedger | undefined
let operationResultStore: PersistentOperationResultStore | undefined
let turnJournal: PersistentTurnJournal | undefined
let rendererAgentState: PersistentRendererAgentState | undefined
let turnJournalReady = false
let aiRuntimeDirectory = ''
let rendererOrigin = ''
let shuttingDown = false
let readyToQuit = false
let sidecarStatus: SidecarStatus = {
  type: 'starting',
  message: 'Starting AI Assistant…'
}

function sanitize(message: unknown): string {
  return String(message)
    .replace(/\bsk-(?:ant|proj|svcacct)-[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/\b(?:Bearer\s+)?eyJ[A-Za-z0-9._-]+\b/gi, '[redacted]')
    .split(sessionToken)
    .join('[redacted]')
}

function configureLogging(): string {
  const logDirectory = path.join(app.getPath('appData'), 'EnvCAD', 'logs')
  mkdirSync(logDirectory, { recursive: true })
  app.setPath('logs', logDirectory)
  log.transports.file.resolvePathFn = () => path.join(logDirectory, 'main.log')
  log.transports.file.level = 'info'
  log.transports.console.level = app.isPackaged ? false : 'info'
  return logDirectory
}

const logDirectory = configureLogging()
const desktopLogger = {
  info(message: string) {
    log.info(sanitize(message))
  },
  warn(message: string) {
    log.warn(sanitize(message))
  },
  error(message: string) {
    log.error(sanitize(message))
  }
}

function publishSidecarStatus(status: SidecarStatus): void {
  sidecarStatus = status
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(DESKTOP_IPC.sidecarStatus, status)
  }
}

function trustedSender(
  event: Pick<
    IpcMainInvokeEvent,
    'sender' | 'senderFrame' | 'frameId' | 'processId'
  >
): boolean {
  const mainFrame = mainWindow?.webContents.mainFrame
  if (
    !mainWindow ||
    !mainFrame ||
    event.sender !== mainWindow.webContents ||
    event.processId !== mainFrame.processId ||
    event.frameId !== mainFrame.routingId ||
    !rendererOrigin
  ) {
    return false
  }
  try {
    const senderFrame = event.senderFrame
    if (
      !senderFrame ||
      senderFrame.processId !== mainFrame.processId ||
      senderFrame.routingId !== mainFrame.routingId
    ) {
      return false
    }
    const senderUrl = senderFrame.url
    return new URL(senderUrl).origin === rendererOrigin
  } catch {
    return false
  }
}

function installIpcHandlers(): void {
  ipcMain.handle(DESKTOP_IPC.getRuntimeConfig, (event): DesktopRuntimeConfig => {
    if (!trustedSender(event)) throw new Error('Untrusted renderer IPC request')
    return { mode: 'desktop', rendererOrigin, sidecar: sidecarStatus }
  })
  ipcMain.handle(DESKTOP_IPC.openLogFolder, async (event) => {
    if (!trustedSender(event)) throw new Error('Untrusted renderer IPC request')
    const error = await shell.openPath(logDirectory)
    return error ? { ok: false, error: 'Windows could not open the EnvCAD log folder.' } : { ok: true }
  })
  ipcMain.handle(DESKTOP_IPC.getAiPreferences, async (event) => {
    if (!trustedSender(event)) throw new Error('Untrusted renderer IPC request')
    if (!aiPreferencesStore) throw new Error('AI preferences are not initialized')
    return aiPreferencesStore.load()
  })
  ipcMain.handle(DESKTOP_IPC.saveAiPreferences, async (event, preferences: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted renderer IPC request')
    if (!aiPreferencesStore) throw new Error('AI preferences are not initialized')
    return aiPreferencesStore.save(preferences)
  })
  ipcMain.handle(
    DESKTOP_IPC.getSheetPreference,
    async (event, documentName: unknown) => {
      if (!trustedSender(event)) throw new Error('Untrusted renderer IPC request')
      if (!sheetPreferencesStore) {
        throw new Error('Sheet preferences are not initialized')
      }
      return sheetPreferencesStore.load(documentName)
    }
  )
  ipcMain.handle(
    DESKTOP_IPC.saveSheetPreference,
    async (event, documentName: unknown, sheet: unknown) => {
      if (!trustedSender(event)) throw new Error('Untrusted renderer IPC request')
      if (!sheetPreferencesStore) {
        throw new Error('Sheet preferences are not initialized')
      }
      return sheetPreferencesStore.save(documentName, sheet)
    }
  )
  ipcMain.on(DESKTOP_IPC.loadAgentState, (event, key: unknown) => {
    let result:
      | { ok: true; value: string | null }
      | { ok: false; message: string }
    if (
      !trustedSender(event) ||
      !rendererAgentState ||
      !isDurableAgentStateKey(key)
    ) {
      result = {
        ok: false,
        message: 'Assistant recovery state is unavailable.'
      }
    } else {
      try {
        result = { ok: true, value: rendererAgentState.load(key) }
      } catch {
        result = {
          ok: false,
          message:
            'EnvCAD could not restore protected assistant recovery state.'
        }
      }
    }
    // Electron resolves sendSync on the first returnValue assignment.
    event.returnValue = result
  })
  ipcMain.on(
    DESKTOP_IPC.saveAgentStateSync,
    (event, key: unknown, value: unknown) => {
      let result: { ok: true } | { ok: false; message: string }
      if (
        !trustedSender(event) ||
        !rendererAgentState ||
        !isDurableAgentStateKey(key) ||
        typeof value !== 'string'
      ) {
        result = {
          ok: false,
          message: 'Assistant recovery state was not saved.'
        }
      } else {
        try {
          rendererAgentState.saveSync(key, value)
          result = { ok: true }
        } catch {
          result = {
            ok: false,
            message:
              'EnvCAD could not save protected assistant recovery state.'
          }
        }
      }
      // Electron resolves sendSync on the first returnValue assignment.
      event.returnValue = result
    }
  )
  ipcMain.handle(
    DESKTOP_IPC.saveAgentState,
    async (event, key: unknown, value: unknown) => {
      if (!trustedSender(event)) throw new Error('Untrusted renderer IPC request')
      if (
        !rendererAgentState ||
        !isDurableAgentStateKey(key) ||
        typeof value !== 'string'
      ) {
        throw new Error('Assistant recovery state is invalid.')
      }
      await rendererAgentState.save(key, value)
    }
  )
  if (!operationLedger || !operationResultStore) {
    throw new Error('Operation journal is not initialized')
  }
  installOperationJournalIpc({
    ipcMain,
    trustedSender,
    ledger: operationLedger,
    results: operationResultStore
  })
}

function isTrustedApplicationUrl(target: string): boolean {
  try {
    const url = new URL(target)
    return (
      url.origin === rendererOrigin &&
      (url.pathname === '/' || url.pathname === '/index.html')
    )
  } catch {
    return false
  }
}

function openAllowedExternalUrl(target: string): void {
  try {
    const url = new URL(target)
    if (url.protocol === 'https:') void shell.openExternal(url.toString())
  } catch {
    desktopLogger.warn('Blocked an invalid external URL.')
  }
}

function configureSessionSecurity(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  session.defaultSession.setPermissionCheckHandler(() => false)
}

function createApplicationMenu(): void {
  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Log Folder',
          click: () => void shell.openPath(logDirectory)
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload', visible: !app.isPackaged },
        { role: 'toggleDevTools', visible: !app.isPackaged },
        { type: 'separator', visible: !app.isPackaged },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Claude Code Setup',
          click: () => openAllowedExternalUrl('https://docs.anthropic.com/en/docs/claude-code/setup')
        },
        {
          label: 'OpenAI Codex Setup',
          click: () => openAllowedExternalUrl('https://developers.openai.com/codex/cli')
        }
      ]
    }
  ])
  Menu.setApplicationMenu(menu)
}

async function createWindow(rendererUrl: string): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    title: 'EnvCAD',
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: '#1a1a1a',
    ...(app.isPackaged
      ? {}
      : { icon: path.join(process.cwd(), 'desktop', 'assets', 'envcad.ico') }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged
    }
  })
  let shown = false
  const showWindow = (reason: 'ready' | 'fallback') => {
    if (shown || window.isDestroyed()) return
    shown = true
    window.show()
    const elapsed = Math.round(performance.now() - startupStartedAt)
    if (reason === 'fallback') {
      desktopLogger.warn(`Application window used the visibility fallback after ${elapsed} ms.`)
    } else {
      desktopLogger.info(`Application window ready in ${elapsed} ms.`)
    }
  }
  const visibilityFallback = setTimeout(() => showWindow('fallback'), 5_000)
  visibilityFallback.unref()
  window.webContents.setWindowOpenHandler(({ url }) => {
    openAllowedExternalUrl(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (isTrustedApplicationUrl(url)) return
    event.preventDefault()
    openAllowedExternalUrl(url)
  })
  window.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (!isMainFrame) return
      desktopLogger.error(
        `Renderer load failed (${errorCode}): ${errorDescription}; URL: ${validatedUrl}`
      )
    }
  )
  window.webContents.on('render-process-gone', (_event, details) => {
    desktopLogger.error(
      `Renderer process exited unexpectedly: ${details.reason} (code ${details.exitCode}).`
    )
  })
  window.once('ready-to-show', () => {
    clearTimeout(visibilityFallback)
    showWindow('ready')
  })
  window.on('closed', () => {
    clearTimeout(visibilityFallback)
    if (mainWindow === window) mainWindow = null
  })
  // Register the window before loading the renderer. The renderer requests its
  // persisted AI preferences during startup, and trustedSender intentionally
  // rejects IPC from any window other than this one.
  mainWindow = window
  try {
    await window.loadURL(rendererUrl)
  } catch (error) {
    clearTimeout(visibilityFallback)
    if (mainWindow === window) mainWindow = null
    if (!window.isDestroyed()) window.destroy()
    throw error
  }
  return window
}

async function startDesktop(): Promise<void> {
  await app.whenReady()
  app.setAppUserModelId(APP_ID)
  configureSessionSecurity()
  aiPreferencesStore = new AiPreferencesStore(
    path.join(app.getPath('userData'), 'ai-preferences.json'),
    desktopLogger
  )
  sheetPreferencesStore = new SheetPreferencesStore(
    path.join(app.getPath('userData'), 'sheet-preferences.json'),
    desktopLogger
  )
  const agentJournalDirectory = path.join(
    app.getPath('userData'),
    'agent-journal-v2'
  )
  rendererAgentState = new PersistentRendererAgentState(
    path.join(agentJournalDirectory, 'renderer'),
    safeStorage
  )
  operationLedger = new PersistentOperationLedger(agentJournalDirectory)
  try {
    const operationReconciliation =
      await reconcileAbandonedOperations(operationLedger)
    if (operationReconciliation.pendingMarkedUnknown > 0) {
      desktopLogger.warn(
        `Marked ${operationReconciliation.pendingMarkedUnknown} interrupted CAD operation(s) unknown; AI writes remain blocked pending reconciliation.`
      )
    }
  } catch (error) {
    desktopLogger.error(
      `Durable operation startup reconciliation failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    publishSidecarStatus({
      type: 'failed',
      message:
        'AI CAD mutation recovery failed. Manual CAD editing remains available; review the diagnostic log before using AI edits.'
    })
  }
  turnJournal = new PersistentTurnJournal(
    path.join(agentJournalDirectory, 'turns')
  )
  try {
    const reconciliation = await reconcileAbandonedTurns(turnJournal)
    turnJournalReady = true
    if (reconciliation.reconciled > 0) {
      desktopLogger.warn(
        `Moved ${reconciliation.reconciled} interrupted AI turn(s) to a safe needs-input outcome without replay.`
      )
    }
  } catch (error) {
    desktopLogger.error(
      `Durable turn startup reconciliation failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    publishSidecarStatus({
      type: 'failed',
      message:
        'AI Assistant durable recovery failed. CAD editing remains available; review the diagnostic log before starting another AI turn.'
    })
  }
  operationResultStore = new PersistentOperationResultStore(
    path.join(agentJournalDirectory, 'results')
  )
  const localAppData = process.env.LOCALAPPDATA
  if (!localAppData) {
    throw new Error('LOCALAPPDATA is unavailable; cannot create the isolated AI runtime.')
  }
  const removedLegacyTranscripts =
    await removeLegacyEnvCadClaudeTranscripts({
      homeDirectory: app.getPath('home'),
      localAppData
    })
  if (removedLegacyTranscripts > 0) {
    desktopLogger.info(
      `Removed ${removedLegacyTranscripts} legacy EnvCAD Claude transcript directories.`
    )
  }
  aiRuntimeDirectory = path.join(
    path.resolve(localAppData),
    'EnvCAD',
    'ai-runtime',
    `session-${process.pid}-${randomBytes(12).toString('hex')}`
  )
  mkdirSync(aiRuntimeDirectory, { recursive: true })

  const developmentUrl =
    typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === 'string'
      ? MAIN_WINDOW_VITE_DEV_SERVER_URL
      : undefined
  let rendererUrl: string
  if (developmentUrl) {
    rendererUrl = developmentUrl
    rendererOrigin = new URL(developmentUrl).origin
  } else {
    const rendererRoot = path.join(__dirname, '..', 'renderer', 'main_window')
    frontendServer = await startFrontendServer({ root: rendererRoot })
    rendererUrl = frontendServer.url
    rendererOrigin = frontendServer.origin
    desktopLogger.info(`Packaged renderer listening at ${rendererOrigin}.`)
  }

  installIpcHandlers()
  createApplicationMenu()
  await createWindow(rendererUrl)

  if (!turnJournalReady) return
  sidecarProcess = new SidecarProcess({
    workerPath: path.join(__dirname, 'sidecarWorker.cjs'),
    permittedOrigin: rendererOrigin,
    sessionToken,
    sessionTokenFactory: () => randomBytes(32).toString('base64url'),
    runtimeDirectory: aiRuntimeDirectory,
    inputStoreDirectory: path.join(agentJournalDirectory, 'inputs'),
    fork(modulePath, options): UtilityProcessLike {
      return utilityProcess.fork(modulePath, [], {
        env: options.env,
        serviceName: options.serviceName,
        stdio: 'ignore'
      }) as UtilityProcessLike
    },
    onStatus: publishSidecarStatus,
    logger: desktopLogger,
    turnJournal
  })
  void sidecarProcess.start()
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  desktopLogger.info('Application shutdown started.')
  try {
    await sidecarProcess?.close()
  } catch (error) {
    desktopLogger.error(
      `AI Assistant shutdown failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
  try {
    await operationLedger?.close()
  } catch (error) {
    desktopLogger.error(
      `Operation journal shutdown failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
  try {
    await turnJournal?.close()
  } catch (error) {
    desktopLogger.error(
      `Turn journal shutdown failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
  try {
    await frontendServer?.close()
  } catch (error) {
    desktopLogger.error(
      `Renderer server shutdown failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
  if (aiRuntimeDirectory) {
    try {
      await removeRuntimeDirectoryWithRetry(aiRuntimeDirectory)
    } catch (error) {
      desktopLogger.error(
        `Isolated AI runtime cleanup failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }
  desktopLogger.info('Application shutdown complete.')
}

if (started) {
  app.quit()
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) focusExistingWindow(mainWindow)
  })
  app.on('activate', () => {
    if (mainWindow) focusExistingWindow(mainWindow)
  })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', (event) => {
    if (readyToQuit) return
    event.preventDefault()
    void shutdown().finally(() => {
      readyToQuit = true
      app.quit()
    })
  })
  void startDesktop().catch((error) => {
    const startupError = sanitize(error instanceof Error ? error.message : String(error))
    desktopLogger.error(`Desktop startup failed: ${startupError}`)
    dialog.showErrorBox(
      'EnvCAD could not start',
      `EnvCAD encountered a startup error and must close.\n\n${startupError}\n\nDiagnostic log:\n${logDirectory}`
    )
    app.quit()
  })
}
