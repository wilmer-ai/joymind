import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { defaultAgent } from '@joymind/core';
import { createJoymindRuntime } from '@joymind/runtime';

test('Desktop reads the same SQLite run history used by the shared runtime and CLI', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'joymind-shared-store-'));
  const dbPath = join(directory, 'joymind.db');
  const seed = await createJoymindRuntime({
    dbPath,
    recover: false,
    scriptedResponses: [[{ type: 'text_delta', text: 'seed complete' }, { type: 'done', reason: 'stop' }]],
  });
  try {
    const run = await seed.runtime.start({ workspacePath: directory, goal: 'Shared SQLite history seed', agent: structuredClone(defaultAgent) });
    for await (const event of seed.runtime.events(run.id)) if (event.type === 'run.completed') break;
  } finally {
    await seed.close();
  }
  const application = await electron.launch({
    args: [resolve('../../packages/desktop')],
    env: { ...process.env, JOYMIND_DB: dbPath, JOYMIND_USER_DATA: join(directory, 'user-data') },
  });
  try {
    const window = await application.firstWindow();
    await expect(window.getByRole('button', { name: /Shared SQLite history seed/ })).toBeVisible();
    await window.getByRole('button', { name: /Shared SQLite history seed/ }).click();
    await expect(window.getByText('seed complete', { exact: true })).toBeVisible();
  } finally {
    await application.close();
  }
});
