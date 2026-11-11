import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { agentDefinitionSchema, defaultAgent, normalizeError } from '@joymind/core';
import type { RunCommand, RunEvent } from '@joymind/core';
import {
  createModelProvider, getProviderDefinition, listProviderModels, providerCatalog, remoteProviderIds, testModelConnection,
} from '@joymind/providers';
import type { RemoteProviderId } from '@joymind/providers';
import { z } from 'zod';
import {
  channels, commandSchema, connectionTestSchema, externalOpenSchema, getRunSchema, listRunsSchema, modelListSchema, preferencesInputSchema,
  secretDeleteSchema, secretSaveSchema, startRunSchema, subscribeSchema, unsubscribeSchema,
} from './contracts.js';
import { applicationMenuTemplate } from './menu.js';
import type { MenuLocale } from './menu.js';
import { PreferencesStore } from './preferences-store.js';
import { ProviderSecretStore } from './secret-store.js';
import type { JoymindRuntimeContext } from '@joymind/runtime';

type SecretProvider = RemoteProviderId;

interface ActiveSubscription {
  iterator: AsyncIterator<RunEvent>;
  stop: () => void;
}

const subscriptions = new Map<number, Map<string, ActiveSubscription>>();
let context: JoymindRuntimeContext | undefined;
let secrets: ProviderSecretStore;
let preferences: PreferencesStore;
let closing: Promise<void> | undefined;
let activeLocale: MenuLocale = 'zh-CN';

if (process.env.JOYMIND_USER_DATA) app.setPath('userData', resolve(process.env.JOYMIND_USER_DATA));

function failure(error: unknown): Error {
  const normalized = normalizeError(error);
  return new Error(normalized.message);
}

function broadcastMenuAction(action: string, locale?: MenuLocale): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channels.menuAction, { action, ...(locale ? { locale } : {}) });
  }
}

function installLocalizedMenu(locale: MenuLocale): void {
  activeLocale = locale;
  const template = applicationMenuTemplate(locale, {
    newTask: () => broadcastMenuAction('new-task'),
    openSettings: () => broadcastMenuAction('open-settings'),
    selectWorkspace: () => broadcastMenuAction('select-workspace'),
    setLocale: (next) => { void changeMenuLocale(next); },
    about: () => {
      const message = locale === 'zh-CN' ? `Joymind ${app.getVersion()}\n本地优先、可审计的 Agent 工具。` : `Joymind ${app.getVersion()}\nA local-first, auditable agent tool.`;
      const owner = BrowserWindow.getFocusedWindow();
      const options = { type: 'info' as const, title: 'Joymind', message };
      if (owner) void dialog.showMessageBox(owner, options);
      else void dialog.showMessageBox(options);
    },
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function changeMenuLocale(locale: MenuLocale): Promise<void> {
  const saved = await preferences.get();
  await preferences.save({ ...saved, locale });
  installLocalizedMenu(locale);
  broadcastMenuAction('set-locale', locale);
}

function handle<Schema extends z.ZodType, Result>(
  channel: string,
  schema: Schema,
  operation: (event: IpcMainInvokeEvent, input: z.infer<Schema>) => Promise<Result>,
): void {
  ipcMain.handle(channel, async (event, input: unknown) => {
    try {
      return await operation(event, schema.parse(input));
    } catch (error) {
      throw failure(error);
    }
  });
}

function senderSubscriptions(sender: WebContents): Map<string, ActiveSubscription> {
  let current = subscriptions.get(sender.id);
  if (!current) {
    current = new Map();
    subscriptions.set(sender.id, current);
    sender.once('destroyed', () => stopSender(sender.id));
  }
  return current;
}

function stopSender(senderId: number): void {
  const current = subscriptions.get(senderId);
  if (!current) return;
  subscriptions.delete(senderId);
  for (const subscription of current.values()) subscription.stop();
}

function stopSubscription(sender: WebContents, subscriptionId: string): void {
  const current = subscriptions.get(sender.id);
  const subscription = current?.get(subscriptionId);
  if (!subscription) return;
  current?.delete(subscriptionId);
  subscription.stop();
}

function subscribe(event: IpcMainInvokeEvent, input: z.infer<typeof subscribeSchema>): void {
  if (!context) throw new Error('Runtime 尚未就绪。');
  const sender = event.sender;
  stopSubscription(sender, input.subscriptionId);
  const iterator = context.runtime.events(input.runId, input.afterSeq)[Symbol.asyncIterator]();
  const current = senderSubscriptions(sender);
  const subscription: ActiveSubscription = {
    iterator,
    stop: () => {
      if (iterator.return) void iterator.return().catch(() => undefined);
    },
  };
  current.set(input.subscriptionId, subscription);

  void (async () => {
    try {
      while (current.get(input.subscriptionId) === subscription) {
        const next = await iterator.next();
        if (next.done) break;
        if (!sender.isDestroyed()) sender.send(channels.event, { subscriptionId: input.subscriptionId, event: next.value });
        if (['run.completed', 'run.failed', 'run.cancelled'].includes(next.value.type)) break;
      }
    } catch (error) {
      if (!sender.isDestroyed() && current.get(input.subscriptionId) === subscription) {
        sender.send(channels.subscriptionError, { subscriptionId: input.subscriptionId, error: normalizeError(error) });
      }
    } finally {
      if (current.get(input.subscriptionId) === subscription) current.delete(input.subscriptionId);
    }
  })();
}

async function registerProvider(provider: SecretProvider, apiKey?: string): Promise<void> {
  if (!context) throw new Error('Runtime is not ready.');
  const definition = getProviderDefinition(provider);
  const saved = await preferences.get();
  const environmentKey = definition.apiKeyEnv ? process.env[definition.apiKeyEnv] : undefined;
  const baseUrl = saved.baseUrls[provider]
    ?? (definition.baseUrlEnv ? process.env[definition.baseUrlEnv] : undefined)
    ?? definition.defaultBaseUrl;
  if (!baseUrl) return;
  const resolvedKey = apiKey ?? await secrets.get(provider) ?? environmentKey;
  context.runtime.registerProvider(provider, createModelProvider({
    provider, baseUrl, ...(resolvedKey ? { apiKey: resolvedKey } : {}),
  }));
}

async function registerAllProviders(): Promise<void> {
  for (const provider of remoteProviderIds()) await registerProvider(provider);
}

async function resolveProviderConnection(input: z.infer<typeof modelListSchema>) {
  const definition = getProviderDefinition(input.provider);
  const saved = await preferences.get();
  const apiKey = input.apiKey ?? await secrets.get(input.provider)
    ?? (definition.apiKeyEnv ? process.env[definition.apiKeyEnv] : undefined);
  const baseUrl = (input.baseUrl || saved.baseUrls[input.provider])
    ?? (definition.baseUrlEnv ? process.env[definition.baseUrlEnv] : undefined)
    ?? definition.defaultBaseUrl;
  const modelListBaseUrl = input.modelListBaseUrl || saved.modelListBaseUrls[input.provider];
  return {
    provider: input.provider, ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseUrl } : {}),
    ...(modelListBaseUrl ? { modelListBaseUrl } : {}),
  };
}

function registerIpc(runtimeContext: JoymindRuntimeContext, secretStore: ProviderSecretStore): void {
  handle(channels.startRun, startRunSchema, async (_event, input) => {
    const agent = structuredClone(defaultAgent);
    agent.spec.model = { provider: input.provider, model: input.model };
    agent.spec.permissions.mode = input.permissionMode;
    const saved = await preferences.get();
    await preferences.save({
      ...saved, workspacePath: input.workspacePath, provider: input.provider, permissionMode: input.permissionMode,
      models: { ...saved.models, [input.provider]: input.model },
    });
    return runtimeContext.runtime.start({
      workspacePath: input.workspacePath,
      goal: input.goal,
      agent: agentDefinitionSchema.parse(agent),
    });
  });
  handle(channels.getRun, getRunSchema, async (_event, input) => runtimeContext.runtime.get(input.runId));
  handle(channels.listRuns, listRunsSchema, async (_event, input) => {
    const runs = await runtimeContext.store.listRuns(input.offset + input.limit + 1);
    return { runs: runs.slice(input.offset, input.offset + input.limit), hasMore: runs.length > input.offset + input.limit };
  });
  handle(channels.command, commandSchema, async (_event, input) => runtimeContext.runtime.command(input.runId, input.command as RunCommand));
  handle(channels.subscribe, subscribeSchema, async (event, input) => {
    subscribe(event, input);
    return { subscribed: true };
  });
  handle(channels.unsubscribe, unsubscribeSchema, async (event, input) => {
    stopSubscription(event.sender, input.subscriptionId);
    return { unsubscribed: true };
  });
  handle(channels.catalog, z.undefined(), async () => providerCatalog);
  handle(channels.secretSettings, z.undefined(), async () => secretStore.settings());
  handle(channels.preferencesGet, z.undefined(), async () => preferences.get());
  handle(channels.preferencesSave, preferencesInputSchema, async (_event, input) => {
    const saved = await preferences.save(input);
    installLocalizedMenu(saved.locale);
    if (context) await registerAllProviders();
    return saved;
  });
  handle(channels.workspaceSelect, z.undefined(), async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = { properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return { path: result.canceled ? null : result.filePaths[0] ?? null };
  });
  handle(channels.externalOpen, externalOpenSchema, async (_event, input) => {
    await shell.openExternal(input.url);
    return { opened: true };
  });
  handle(channels.connectionTest, connectionTestSchema, async (_event, input) => {
    await testModelConnection(await resolveProviderConnection(input), input.model);
    return { connected: true };
  });
  handle(channels.modelList, modelListSchema, async (_event, input) => ({
    models: await listProviderModels(await resolveProviderConnection(input)),
  }));
  handle(channels.secretSave, secretSaveSchema, async (_event, input) => {
    await secretStore.save(input.provider, input.apiKey);
    await registerProvider(input.provider, input.apiKey);
    return secretStore.settings();
  });
  handle(channels.secretDelete, secretDeleteSchema, async (_event, input) => {
    await secretStore.remove(input.provider);
    await registerProvider(input.provider);
    return secretStore.settings();
  });
}

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 900,
    minHeight: 650,
    show: false,
    backgroundColor: '#f3f5f2',
    title: 'Joymind',
    webPreferences: {
      preload: join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());

  const developmentUrl = process.env.JOYMIND_DEV_SERVER_URL;
  if (developmentUrl) await window.loadURL(developmentUrl);
  else if (app.isPackaged) await window.loadFile(join(process.resourcesPath, 'app', 'index.html'));
  else await window.loadFile(join(import.meta.dirname, '..', '..', 'app', 'dist', 'index.html'));
}

async function initialize(): Promise<void> {
  await app.whenReady();
  secrets = new ProviderSecretStore(app.getPath('userData'));
  preferences = new PreferencesStore(app.getPath('userData'));
  installLocalizedMenu((await preferences.get()).locale);
  const runtimeModule = await import('@joymind/runtime');
  const dbPath = process.env.JOYMIND_DB ?? join(homedir(), '.joymind', 'joymind.db');
  context = await runtimeModule.createJoymindRuntime({ dbPath });
  await registerAllProviders();
  await context.runtime.recoverInterrupted();
  registerIpc(context, secrets);
  await createWindow();
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (context && BrowserWindow.getAllWindows().length === 0) void createWindow().catch((error: unknown) => dialog.showErrorBox('Joymind', failure(error).message));
});

app.on('before-quit', (event) => {
  for (const senderId of [...subscriptions.keys()]) stopSender(senderId);
  if (!context || closing) return;
  event.preventDefault();
  const current = context;
  closing = current.close().catch(() => undefined).finally(() => {
    context = undefined;
    app.quit();
  });
});

void initialize().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  try { writeFileSync(join(app.getPath('userData'), 'startup-error.log'), message, { encoding: 'utf8', mode: 0o600 }); } catch { /* Keep the startup dialog as the final fallback. */ }
  dialog.showErrorBox(
    activeLocale === 'zh-CN' ? 'Joymind 启动失败' : 'Joymind failed to start',
    activeLocale === 'zh-CN'
      ? `${failure(error).message}\n\n请确认运行依赖完整，并查看应用数据目录中的 startup-error.log。`
      : `${failure(error).message}\n\nCheck the installation and startup-error.log in the application data directory.`,
  );
  app.quit();
});
