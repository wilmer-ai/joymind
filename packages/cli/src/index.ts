#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stderr, stdin, stdout } from 'node:process';
import { resolve } from 'node:path';
import { Command, Option } from 'commander';
import { defaultAgent, type PermissionMode, type RunCommand, type RunEvent } from '@joymind/core';
import { getProviderDefinition, providerCatalog } from '@joymind/providers';
import { createJoymindRuntime } from '@joymind/runtime';
import { cliMessages, localeFromArguments, localizedStatus } from './i18n.js';

interface GlobalOptions { db?: string; json?: boolean; locale: string }
const locale = localeFromArguments(process.argv);
const messages = cliMessages(locale);
const program = new Command();
program.name('joymind').description(messages.description).version('0.4.0')
  .option('--db <path>', messages.dbOption).option('--json', messages.jsonOption)
  .addOption(new Option('--locale <locale>', messages.localeOption).choices(['zh-CN', 'en-US']).default(locale));

function print(value: unknown, json = false): void {
  stdout.write(`${json ? JSON.stringify(value) : typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

async function withRuntime<T>(operation: (context: Awaited<ReturnType<typeof createJoymindRuntime>>) => Promise<T>): Promise<T> {
  const options = program.opts<GlobalOptions>();
  const context = await createJoymindRuntime({ ...(options.db ? { dbPath: options.db === ':memory:' ? options.db : resolve(options.db) } : {}) });
  try { return await operation(context); } finally { await context.close(); }
}

program.command('run').description(messages.runDescription).argument('<goal>')
  .option('--workspace <path>', messages.workspaceOption, '.')
  .option('--provider <id>', messages.providerOption, 'scripted')
  .option('--model <name>', messages.modelOption)
  .option('--approve', messages.approveOption)
  .addOption(new Option('--permission <mode>', messages.permissionOption).choices(['ask', 'auto', 'autonomous']).default('ask'))
  .action(async (goal: string, options: { workspace: string; provider: string; model?: string; approve?: boolean; permission: PermissionMode }) => {
  const global = program.opts<GlobalOptions>();
  const exitCode = await withRuntime(async ({ runtime }) => {
    const agent = structuredClone(defaultAgent);
    agent.spec.permissions.mode = options.permission;
    agent.spec.model.provider = options.provider;
    agent.spec.model.model = options.model ?? getProviderDefinition(options.provider).defaultModel;
    const run = await runtime.start({ workspacePath: resolve(options.workspace), goal, agent });
    if (!global.json) print(messages.runStarted(run.id));
    const events = runtime.events(run.id);
    const sigint = () => { void runtime.command(run.id, { commandId: randomUUID(), type: 'cancel', reason: 'SIGINT' }); };
    process.once('SIGINT', sigint);
    try {
      for await (const event of events) {
        if (global.json) print(event, true);
        else renderEvent(event);
        if (event.type === 'tool.approval_required') {
          const payload = event.payload as { approvalId: string; name: string; arguments: unknown };
          let command: RunCommand;
          if (options.approve) command = { commandId: randomUUID(), type: 'approve', approvalId: payload.approvalId };
          else if (!stdin.isTTY) {
            await runtime.command(run.id, { commandId: randomUUID(), type: 'cancel', reason: 'Approval required in non-interactive mode' });
            print(messages.approvalRequired, false);
            return 5;
          } else {
            const rl = createInterface({ input: stdin, output: stderr });
            const answer = await rl.question(messages.approvalPrompt(payload.name, JSON.stringify(payload.arguments)));
            rl.close();
            command = answer.trim().toLowerCase() === 'y'
              ? { commandId: randomUUID(), type: 'approve', approvalId: payload.approvalId }
              : { commandId: randomUUID(), type: 'reject', approvalId: payload.approvalId, reason: 'Rejected in CLI' };
          }
          await runtime.command(run.id, command);
        }
        if (['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)) break;
      }
    } finally { process.removeListener('SIGINT', sigint); }
    const final = await runtime.get(run.id);
    if (!global.json) print(`\n${localizedStatus(final.status, messages)}: ${final.finishReason ?? final.error?.message ?? ''}`);
    return final.status === 'completed' ? 0 : final.status === 'cancelled' ? 2 : 1;
  });
  process.exitCode = exitCode;
});

const runs = program.command('runs').description(messages.runsDescription);
runs.command('list').action(async () => withRuntime(async ({ runtime }) => {
  print(await runtime.listRuns(), program.opts<GlobalOptions>().json);
}));

runs.command('show').argument('<runId>').action(async (runId: string) => withRuntime(async ({ runtime }) => {
  print(await runtime.get(runId), program.opts<GlobalOptions>().json);
}));

runs.command('events').argument('<runId>').action(async (runId: string) => withRuntime(async ({ store }) => {
  const events = await store.listEvents(runId);
  print(events, program.opts<GlobalOptions>().json);
}));

runs.command('cancel').argument('<runId>').action(async (runId: string) => withRuntime(async ({ runtime }) => {
  print(await runtime.command(runId, { commandId: randomUUID(), type: 'cancel', reason: 'Cancelled from CLI' }), program.opts<GlobalOptions>().json);
}));

const providers = program.command('providers').description(messages.providersDescription);
providers.command('list').action(async () => withRuntime(async ({ providers: registered }) => {
  print(providerCatalog.map((provider) => ({ ...provider, configured: Boolean(registered[provider.id]) })), program.opts<GlobalOptions>().json);
}));

const tools = program.command('tools').description(messages.toolsDescription);
tools.command('list').action(async () => withRuntime(async ({ runtime }) => {
  print(await runtime.listTools(), program.opts<GlobalOptions>().json);
}));

function renderEvent(event: RunEvent): void {
  if (event.type === 'message.assistant.delta') stdout.write((event.payload as { text: string }).text);
  else if (event.type === 'tool.requested') { const p = event.payload as { name: string }; print(`\n[${messages.tool}] ${p.name}`); }
  else if (event.type === 'tool.completed') { const p = event.payload as { name: string; result: { content: Array<{ text?: string }> } }; print(`[${messages.done}] ${p.name}: ${p.result.content.map((item) => item.text ?? '').join('\n')}`); }
  else if (event.type === 'tool.failed') print(`[${messages.toolFailed}] ${JSON.stringify(event.payload)}`);
  else if (event.type === 'run.failed') print(`\n[${messages.failed}] ${JSON.stringify(event.payload)}`);
}

await program.parseAsync(process.argv);
