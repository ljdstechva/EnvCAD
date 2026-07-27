import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  session,
  shell,
  utilityProcess,
  type IpcMainInvokeEvent
} from 'electron'
import log from 'electron-log/main'
import { startFrontendServer, type FrontendServerHandle } from './frontendServer'
import {
  DESKTOP_IPC,
  type DesktopRuntimeConfig,
  type SidecarStatus
} from './runtimeProtocol'
import { SidecarProcess, type UtilityProcessLike } from './sidecarProcess'
import { handleSquirrelStartup } from './squirrelStartup'
import { focusExistingWindow } from './windowLifecycle'

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined

const APP_ID = 'com.ljdstechva.envcad'
const started = handleSquirrelStartup()
const startupStartedAt = performance.now()
const sessionToken = randomBytes(32).toString('base64url')
let mainWindow: BrowserWindow | null = null
let frontendServer: FrontendServerHandle | undefined
let sidecarProcess: SidecarProcess | undefined
let rendererOrigin = ''
let shuttingDown = false
let readyToQuit = false
let sidecarStatus: SidecarStatus = {
  type: 'starting',
  message: 'Starting AI Assistant…'
}

function sanitize(message: unknown): string {
  return String(message)
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted]')
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

function trustedSender(event: IpcMainInvokeEvent): boolean {
  if (!mainWindow || event.sender !== mainWindow.webContents || !rendererOrigin) return false
  try {
    const senderUrl = event.senderFrame?.url
    if (!senderUrl) return false
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
  window.webContents.setWindowOpenHandler(({ url }) => {
    openAllowedExternalUrl(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (isTrustedApplicationUrl(url)) return
    event.preventDefault()
    openAllowedExternalUrl(url)
  })
  window.once('ready-to-show', () => {
    window.show()
    desktopLogger.info(
      `Application window ready in ${Math.round(performance.now() - startupStartedAt)} ms.`
    )
  })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })
  await window.loadURL(rendererUrl)
  return window
}

async function startDesktop(): Promise<void> {
  await app.whenReady()
  app.setAppUserModelId(APP_ID)
  configureSessionSecurity()

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
  mainWindow = await createWindow(rendererUrl)

  sidecarProcess = new SidecarProcess({
    workerPath: path.join(__dirname, 'sidecarWorker.cjs'),
    permittedOrigin: rendererOrigin,
    sessionToken,
    fork(modulePath, options): UtilityProcessLike {
      return utilityProcess.fork(modulePath, [], {
        env: options.env,
        serviceName: options.serviceName,
        stdio: 'ignore'
      }) as UtilityProcessLike
    },
    onStatus: publishSidecarStatus,
    logger: desktopLogger
  })
  void sidecarProcess.start()
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  desktopLogger.info('Application shutdown started.')
  await sidecarProcess?.close()
  await frontendServer?.close()
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
    desktopLogger.error(
      `Desktop startup failed: ${error instanceof Error ? error.message : String(error)}`
    )
    app.quit()
  })
}
