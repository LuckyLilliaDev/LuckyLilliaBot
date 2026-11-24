import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  CoreUpdateBar,
  StatusNotices,
  Sidebar,
  TokenDialog,
  ToastContainer,
  AnimatedBackground,
} from './components';
import { iconByName } from './components/plugins/meta';
import {
  builtinPageKeys, PluginPage, PluginPageHeader, PluginPageUnavailable, usePluginHost, usePluginList, useVisiblePages,
  SlotOutlet,
} from './plugin-host';
import { ResConfig } from './types';
import { apiFetch, setPasswordPromptHandler } from './utils/api';
import { instanceHref, pageInstance } from './utils/base';
import { useBots, useBotsPolling } from './stores/botsStore';
import { shouldShowSidebarDot, useCoreUpdatePolling, useCoreUpdateStore } from './stores/coreUpdateStore';
import { useLayout } from './stores/layoutStore';
import { readLastInstance, rememberLastInstance, useManagerPolling, useManagerStore } from './stores/managerStore';
import { registerInstancesPage } from './core';
import AboutPage from './core/AboutPage';
import InstancesPage from './core/InstancesPage';
import ReleaseNotesDialog from './core/ReleaseNotesDialog';
import WebuiPage from './core/WebuiPage';
import { Info, Loader2, Menu, Server, Settings } from 'lucide-react';

// Every tab is a plugin page. Builtins register theirs before the first render (registerCorePages,
// startBuiltinClients); packages' pages come with the plugin list, so their tabs are recognised by shape,
// `<package>:<page id>`. `instances` is registered dynamically once manager mode is confirmed.
const isKnownTab = (tab: string) => tab === 'instances' || builtinPageKeys().has(tab) || tab.includes(':')

type OfflineTab = 'instances' | 'webui' | 'about'

/** `#<tab>`, or `#<tab>?fullscreen` for a page on its own (ctx.pageHref). */
function readHash(): { tab: string; fullscreen: boolean } | undefined {
  const [tab, query = ''] = window.location.hash.slice(1).split('?')
  if (!isKnownTab(tab)) return
  return { tab, fullscreen: new URLSearchParams(query).has('fullscreen') }
}

function App() {
  const currentInstance = pageInstance();
  // Unset: the first page of the sidebar, which is known once the plugin list is
  const [activeTab, setActiveTab] = useState<string | undefined>(() => readHash()?.tab);
  // Fixed for the window: such a page is opened in a window of its own and leaves it by its links
  const [fullscreen, setFullscreen] = useState(() => readHash()?.fullscreen ?? false);

  const [checkingLogin, setCheckingLogin] = useState(true);
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [passwordResolve, setPasswordResolve] = useState<((value: string) => void) | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [wide, setWide] = useState(() => window.matchMedia('(min-width: 48rem)').matches);

  useEffect(() => {
    const media = window.matchMedia('(min-width: 48rem)');
    const change = () => setWide(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);

  const sidebarCollapsed = useLayout(state => state.sidebarCollapsed);
  const setSidebarCollapsed = useLayout(state => state.setSidebarCollapsed);
  const managerStatus = useManagerStore(state => state.status);
  const managerError = useManagerStore(state => state.error);
  const instances = useManagerStore(state => state.instances);

  const managed = managerStatus === 'managed';
  const activeInstance = useMemo(
    () => (managed && currentInstance ? instances.find(item => item.name === currentInstance) : undefined),
    [managed, currentInstance, instances],
  );

  // Register the built-in `实例管理` sidebar page only when running under the unified manager
  useEffect(() => (managed ? registerInstancesPage() : undefined), [managed]);

  // Only connect to the instance's plugin list & bot polling once logged in AND the instance is actually running
  const instanceRunning = !checkingLogin && (
    managed ? activeInstance?.phase === 'running' : managerStatus === 'standalone'
  );

  // Drop stale instance plugin/bot state whenever the instance stops
  const wasRunningRef = useRef(false);
  useEffect(() => {
    if (wasRunningRef.current && !instanceRunning) {
      usePluginList.setState({ plugins: null });
      useBots.setState({ bots: null });
    }
    wasRunningRef.current = instanceRunning;
  }, [instanceRunning]);

  usePluginHost(instanceRunning);
  useBotsPolling(instanceRunning);
  useCoreUpdatePolling(!checkingLogin && (managed || instanceRunning));
  useManagerPolling(!checkingLogin);

  const updateStatus = useCoreUpdateStore(state => state.status);
  const updatePrefs = useCoreUpdateStore(state => state.prefs);
  const aboutBadge = shouldShowSidebarDot(updateStatus, updatePrefs);

  const offlinePages = useMemo(() => [
    { id: 'instances', title: '实例管理', icon: Server },
    { id: 'webui', title: '页面设置', icon: Settings },
    { id: 'about', title: '关于', icon: Info, badge: aboutBadge },
  ], [aboutBadge]);

  const plugins = usePluginList(state => state.plugins);
  const pluginPages = useVisiblePages();
  const openablePages = useVisiblePages('open');
  const tab = activeTab ?? pluginPages[0]?.key ?? 'plugins';
  const currentOfflineTab: OfflineTab = activeTab === 'webui' || activeTab === 'about' ? activeTab : 'instances';
  const currentPluginPage = openablePages.find(page => page.key === tab);
  const sidebarPluginPages = useMemo(
    () => pluginPages.map(page => ({ id: page.key, title: page.title, icon: iconByName(page.icon), badge: page.key === 'about' ? aboutBadge : undefined })),
    [pluginPages, aboutBadge],
  );

  const listed = plugins !== null;
  const offlineShell = managed && !instanceRunning;

  useEffect(() => {
    if (currentInstance) document.title = `LLBot - ${currentInstance}`;
    else document.title = 'LLBot';
  }, [currentInstance]);

  useEffect(() => {
    setPasswordPromptHandler(async (tip: string) => {
      return new Promise<string>((resolve) => {
        setPasswordError(tip || '');
        setShowPasswordDialog(true);
        setPasswordResolve(() => resolve);
      });
    });
  }, []);

  useEffect(() => {
    if (offlineShell) {
      const targetHash = `#${currentOfflineTab}`
      if (window.location.hash !== targetHash) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search + targetHash)
      }
      useLayout.setState({ activeTab: currentOfflineTab })
      return
    }
    // Not before the list is in: the default tab is only known then
    if (!listed) return
    const targetHash = `#${fullscreen ? `${tab}?fullscreen` : tab}`
    if (window.location.hash !== targetHash) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search + targetHash)
    }
    useLayout.setState({ activeTab: tab })
  }, [tab, fullscreen, listed, offlineShell, currentOfflineTab])

  useEffect(() => {
    const handleHashChange = () => {
      const view = readHash()
      if (view) {
        setActiveTab(view.tab)
        setFullscreen(view.fullscreen)
      }
    }
    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [])

  const handlePasswordConfirm = useCallback((password: string) => {
    if (password.trim()) {
      setShowPasswordDialog(false);
      setPasswordError('');
      if (passwordResolve) {
        passwordResolve(password);
        setPasswordResolve(null);
      }
    } else {
      setPasswordError('密码不能为空');
    }
  }, [passwordResolve]);

  useEffect(() => {
    let cancelled = false
    const bootstrap = async () => {
      let redirecting = false
      try {
        // Probe the manager first (works at both `/` and `/i/<name>/`, handles unified login even if the instance is stopped)
        const isManaged = await useManagerStore.getState().probe()
        if (cancelled) return
        if (isManaged) {
          const state = useManagerStore.getState()
          if (!currentInstance) {
            const remembered = readLastInstance()
            const target = (remembered && state.instances.some(item => item.name === remembered) ? remembered : undefined)
              ?? (state.instances.some(item => item.name === state.selected) ? state.selected : undefined)
              ?? state.instances.find(item => item.isDefault)?.name
              ?? state.instances[0]?.name
            if (target) {
              redirecting = true
              rememberLastInstance(target)
              window.location.replace(instanceHref(target) + window.location.hash)
              return
            }
          } else if (state.instances.some(item => item.name === currentInstance)) {
            rememberLastInstance(currentInstance)
          }
          return
        }
        if (useManagerStore.getState().status === 'standalone') {
          await apiFetch<ResConfig>('/api/config').catch(() => {})
        }
      } catch (error) {
        console.error('Failed to check login status:', error)
      } finally {
        if (!cancelled && !redirecting) setCheckingLogin(false)
      }
    }
    void bootstrap()
    return () => { cancelled = true }
  }, [currentInstance]);

  // Manager probe failed during login/startup (e.g. account locked or network unreachable)
  if (!checkingLogin && managerStatus === 'unknown') {
    return (
      <>
        <AnimatedBackground />
        <div className="relative flex items-center justify-center min-h-screen p-4 z-10">
          <div className="card p-6 max-w-sm w-full text-center space-y-4">
            <h2 className="text-lg font-semibold text-theme">无法连接到服务</h2>
            <p className="text-sm text-theme-secondary">{managerError || '登录验证失败或服务未就绪'}</p>
            <button type="button" onClick={() => window.location.reload()} className="btn-primary px-5 py-2 text-sm">
              重新加载
            </button>
          </div>
        </div>
        <TokenDialog
          visible={showPasswordDialog}
          onConfirm={handlePasswordConfirm}
          error={passwordError}
        />
        <ToastContainer />
      </>
    )
  }

  // Initial login / plugin list bootstrap
  if (checkingLogin || (!managed && !listed)) {
    return (
      <>
        <AnimatedBackground />

        <div className="relative flex items-center justify-center min-h-screen z-10">
          <Loader2 size={48} className="animate-spin text-pink-500" />
        </div>

        {/* 加载时也可能 401, 要能设置密码 */}
        <TokenDialog
          visible={showPasswordDialog}
          onConfirm={handlePasswordConfirm}
          error={passwordError}
        />
      </>
    );
  }

  // Fullscreen standalone plugin window (`#<tab>?fullscreen`)
  if (fullscreen && instanceRunning && listed) {
    return (
      <>
        <AnimatedBackground />

        <div className="relative h-screen overflow-auto z-10">
          <div className="sticky top-0 z-30">
            <CoreUpdateBar />
          </div>
          <div className="p-4 md:p-8">
            {currentPluginPage ? <PluginPage page={currentPluginPage} fullscreen /> : <PluginPageUnavailable tab={tab} />}
          </div>
        </div>

        <TokenDialog
          visible={showPasswordDialog}
          onConfirm={handlePasswordConfirm}
          error={passwordError}
        />

        <ToastContainer />
      </>
    )
  }

  const sidebarItems = offlineShell || !listed ? offlinePages : sidebarPluginPages;
  const sidebarActiveTab = offlineShell || !listed ? currentOfflineTab : tab;

  return (
    <div className="flex min-h-screen">
      <AnimatedBackground />

      <Sidebar
        activeTab={sidebarActiveTab}
        onTabChange={setActiveTab}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
        pluginPages={sidebarItems}
        hideAccounts={offlineShell || !listed}
      />

      <main className={`flex-1 min-w-0 overflow-x-clip z-10 transition-all duration-300 ${sidebarCollapsed ? '' : 'md:ml-[17.5rem]'}`}>
        <div className="sticky top-0 z-30">
          {/* 移动端顶部导航栏 */}
          <div className="md:hidden glass glass-regular rounded-none px-4 py-3 flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen(true)}
              className="p-2 text-theme-muted hover:text-theme hover:bg-theme-item rounded-lg transition-colors"
            >
              <Menu size={24} />
            </button>
            <div className="flex items-center gap-2">
              <img
                src="logo-64.webp"
                srcSet="logo-64.webp 64w, logo-128.webp 128w, logo-192.webp 192w"
                sizes="32px"
                alt="Logo"
                className="w-8 h-8 rounded-lg"
              />
              <span className="font-semibold text-theme">LLBot</span>
            </div>
            {!wide && instanceRunning && listed && currentPluginPage && (
              <div className="ml-auto flex items-center gap-2">
                <SlotOutlet
                  name="page.header.actions"
                  props={{ page: { key: currentPluginPage.key, owner: currentPluginPage.owner, title: currentPluginPage.title, fullscreen: false } }}
                />
              </div>
            )}
          </div>
          {/* 更新中 / 重启中顶部常驻提示 */}
          <CoreUpdateBar />
        </div>

        <div className="p-4 md:p-8 max-w-6xl mx-auto">
          {offlineShell ? (
            <>
              <StatusNotices activeTab={currentOfflineTab} onOpen={setActiveTab} />
              {currentOfflineTab === 'webui'
                ? <WebuiPage managerOverview />
                : currentOfflineTab === 'about'
                  ? <AboutPage />
                  : <InstancesPage />}
            </>
          ) : !listed ? (
            <div className="flex items-center justify-center min-h-[calc(100vh-8rem)]">
              <Loader2 size={40} className="animate-spin text-pink-500" />
            </div>
          ) : (
            <>
              <StatusNotices activeTab={tab} onOpen={setActiveTab} />
              {/* Header - 桌面端显示: the page's own (PageOptions.header), else just room */}
              <div className="mb-8 hidden md:flex items-center gap-4">
                {currentPluginPage && <>
                  <div className="flex-1 min-w-0"><PluginPageHeader page={currentPluginPage} /></div>
                  {wide && <div className="flex items-center gap-2"><SlotOutlet name="page.header.actions" props={{ page: { key: currentPluginPage.key, owner: currentPluginPage.owner, title: currentPluginPage.title, fullscreen: false } }} /></div>}
                </>}
              </div>

              {currentPluginPage ? <PluginPage page={currentPluginPage} /> : <PluginPageUnavailable tab={tab} />}
            </>
          )}
        </div>
      </main>

      <ReleaseNotesDialog />

      <TokenDialog
        visible={showPasswordDialog}
        onConfirm={handlePasswordConfirm}
        error={passwordError}
      />

      <ToastContainer />
    </div>
  );
}

export default App;
