import { vi } from 'vitest'

vi.mock('@/common/globalVars', () => ({
  DATA_DIR: '/tmp/test-data',
  TEMP_DIR: '/tmp/test-data/temp',
  LOG_DIR: '/tmp/test-data/logs',
  dbDir: '/tmp/test-data/database',
  getFixedDataDir: vi.fn(() => '/tmp/test-fixed'),
}))

vi.mock('@/main/config', () => ({
  webuiTokenUtil: {
    getToken: vi.fn(() => 'test-token'),
    setToken: vi.fn(),
  },
  getConfigUtil: vi.fn(() => ({
    getConfig: vi.fn(() => ({
      ob11: { enable: false, connect: [] },
      satori: { enable: false },
      milky: { enable: false },
      webui: { enable: true, host: '0.0.0.0', port: 3080 },
    })),
    setConfig: vi.fn(),
  })),
}))

vi.mock('@/main/log', () => ({
  getLogCache: vi.fn(() => []),
}))

// isDevMode is read on import by the config service
vi.mock('@/common/utils/environment', () => ({
  isDockerEnvironment: vi.fn(() => false),
  isDevMode: vi.fn(() => false),
  getSpecifiedUin: vi.fn(() => undefined),
  getPluginDirs: vi.fn(() => []),
  isPluginHmr: vi.fn(() => false),
  getInstanceArg: vi.fn(() => undefined),
}))
