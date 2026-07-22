/** Shared spawn-a-real-server harness for e2e tests (MOCK_AI, temp data dir). */
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface TestServer {
  base: string;
  temp: string;
  dataDir: string;
  cacheDir: string;
  logs: () => string;
  /** restart the same process against the same data dir (keyring is lost) */
  restart: () => Promise<void>;
  stop: () => Promise<void>;
  cleanup: () => Promise<void>;
}

export async function startServer(
  portOffset = 0,
  extraEnv: Record<string, string> = {},
): Promise<TestServer> {
  const temp = await mkdtemp(`${tmpdir()}/nianxiang-e2e-`);
  const copiedServer = resolve(temp, 'server');
  await mkdir(copiedServer, { recursive: true });
  await cp(resolve(SERVER_ROOT, 'src'), resolve(copiedServer, 'src'), { recursive: true });
  await cp(resolve(SERVER_ROOT, 'package.json'), resolve(copiedServer, 'package.json'));
  await symlink(resolve(SERVER_ROOT, 'node_modules'), resolve(copiedServer, 'node_modules'), 'dir');

  const port = 21_000 + ((process.pid + portOffset * 137) % 18_000);
  const base = `http://127.0.0.1:${port}`;
  let child: ChildProcess | null = null;
  let logs = '';

  const spawnChild = async () => {
    child = spawn(process.execPath, ['server/src/index.ts'], {
      cwd: temp,
      env: {
        ...process.env,
        PORT: String(port),
        MOCK_AI: '1',
        JWT_SECRET: 'e2e-secret-that-is-long-enough',
        INFERENCE_DISABLED: '1',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk) => { logs += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { logs += chunk.toString(); });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode != null) throw new Error(`server exited with ${child.exitCode}\n${logs}`);
      try {
        const response = await fetch(`${base}/api/v1/health`);
        if (response.ok) return;
      } catch {
        // starting
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`server did not start\n${logs}`);
  };

  const stop = async () => {
    if (child && child.exitCode == null) {
      const exited = new Promise((r) => child!.once('exit', r));
      child.kill('SIGTERM');
      await exited;
    }
    child = null;
  };

  await spawnChild();

  return {
    base,
    temp,
    dataDir: resolve(temp, 'server/data'),
    cacheDir: resolve(temp, 'server/cache'),
    logs: () => logs,
    restart: async () => {
      await stop();
      await spawnChild();
    },
    stop,
    cleanup: async () => {
      await stop();
      await rm(temp, { recursive: true, force: true });
    },
  };
}

export async function json(base: string, path: string, init: RequestInit = {}) {
  const response = await fetch(base + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
  const body = await response.json().catch(() => null);
  return { response, body };
}

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });

export const TEST_JPEG = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], {
  type: 'image/jpeg',
});

export function uploadForm(entryId: string, takenAt = Date.now()): FormData {
  const form = new FormData();
  form.set('meta', JSON.stringify({ id: entryId, takenAt, status: 'new' }));
  form.set('image', TEST_JPEG, 'image.jpg');
  form.set('thumb', TEST_JPEG, 'thumb.jpg');
  return form;
}

/** Recursively scan every file under dirs for plaintext markers; returns hits. */
export async function scanForPlaintext(dirs: string[], markers: string[]): Promise<string[]> {
  const hits: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      let buf: Buffer;
      try {
        buf = await readFile(path);
      } catch {
        await walk(path);
        continue;
      }
      const text = buf.toString('utf8');
      for (const marker of markers) {
        if (text.includes(marker)) hits.push(`${path} contains "${marker.slice(0, 20)}"`);
      }
    }
  };
  for (const dir of dirs) await walk(dir);
  return hits;
}
