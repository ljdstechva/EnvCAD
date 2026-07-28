import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FuseV1Options, FuseVersion } from '@electron/fuses'
import {
  flipFuses as flipAllFuses,
  FuseV1Options as CompleteFuseV1Options,
  FuseVersion as CompleteFuseVersion
} from '@electron/fuses-v2'
import { MakerSquirrel } from '@electron-forge/maker-squirrel'
import { FusesPlugin } from '@electron-forge/plugin-fuses'
import { VitePlugin } from '@electron-forge/plugin-vite'
import type { ForgeConfig } from '@electron-forge/shared-types'

const root = path.dirname(fileURLToPath(import.meta.url))
const icon = path.join(root, 'desktop', 'assets', 'envcad.ico')

const config: ForgeConfig = {
  hooks: {
    async packageAfterCopy(_forgeConfig, buildPath, _electronVersion, platform) {
      if (platform !== 'win32') return
      await flipAllFuses(path.resolve(buildPath, '..', '..', 'electron.exe'), {
        version: CompleteFuseVersion.V1,
        [CompleteFuseV1Options.RunAsNode]: false,
        [CompleteFuseV1Options.EnableCookieEncryption]: true,
        [CompleteFuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
        [CompleteFuseV1Options.EnableNodeCliInspectArguments]: false,
        [CompleteFuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
        [CompleteFuseV1Options.OnlyLoadAppFromAsar]: true,
        [CompleteFuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
        [CompleteFuseV1Options.GrantFileProtocolExtraPrivileges]: false,
        [CompleteFuseV1Options.WasmTrapHandlers]: true,
        strictlyRequireAllFuses: true
      })
    }
  },
  packagerConfig: {
    asar: true,
    icon,
    executableName: 'EnvCAD',
    appBundleId: 'com.ljdstechva.envcad',
    win32metadata: {
      ProductName: 'EnvCAD',
      FileDescription: 'Environmental CAD drafting application'
    },
    ignore: [
      /^\/node_modules(?:\/|$)/,
      /^\/(?:src|sidecar|desktop|scripts|test|docs|reference|public)(?:\/|$)/,
      /^\/(?:dist|output|playwright-report|test-results)(?:\/|$)/,
      /^\/\.(?:git|playwright-cli)(?:\/|$)/,
      /^\/\.env(?:\.|$)/,
      /^\/index\.html$/,
      /^\/patches(?:\/|$)/,
      /^\/(?:annotation-|envcad-dev|p4-|p5)[^/]*\.log$/,
      /^\/(?:README|TESTING)\.md$/,
      /^\/(?:forge|vite|playwright|tsconfig)[^/]*\.(?:ts|json|tsbuildinfo)$/
    ]
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      name: 'EnvCAD',
      authors: 'ljdstechva',
      description:
        'Environmental CAD drafting with a secure multi-provider AI Assistant',
      setupExe: 'EnvCAD-0.2.2 Setup.exe',
      setupIcon: icon,
      noMsi: true
    })
  ],
  plugins: [
    new VitePlugin({
      concurrent: 2,
      build: [
        {
          entry: 'desktop/main.ts',
          config: 'vite.main.config.ts',
          target: 'main'
        },
        {
          entry: 'desktop/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload'
        },
        {
          entry: 'desktop/sidecarWorker.ts',
          config: 'vite.sidecar.config.ts',
          target: 'main'
        }
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts'
        }
      ]
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
      // Forge 7.11.2's peer-compatible @electron/fuses 1.8 predates
      // Electron 43's ninth fuse. The packageAfterCopy hook above applies and
      // strictly verifies all nine with a separately aliased current fuses
      // implementation; this plugin then reinforces the eight it knows.
      strictlyRequireAllFuses: false
    })
  ]
}

export default config
