/** Runtime registration policy, ops-managed: data/ops-config.json.
 *  Once the file exists it is FULLY authoritative — registrationCode:null means
 *  "no code required" and does NOT fall back to the REGISTRATION_CODE env var,
 *  otherwise rotating the code could never revoke the env-configured one. */
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createKeyedQueue } from '../lib/keyedQueue.ts';
import { writeAtomic } from '../lib/atomicFile.ts';

export interface RegistrationPolicy {
  open: boolean;
  code: string | null;
  source: 'ops' | 'env';
}

const DATA_DIR = fileURLToPath(new URL('../../data/', import.meta.url));
const FILE = DATA_DIR + 'ops-config.json';
const enqueue = createKeyedQueue();

interface OpsConfig {
  registrationOpen: boolean;
  registrationCode: string | null;
}

function normalize(raw: unknown): OpsConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  return {
    registrationOpen: v.registrationOpen !== false,
    registrationCode:
      typeof v.registrationCode === 'string' && v.registrationCode
        ? v.registrationCode.slice(0, 64)
        : null,
  };
}

async function readConfig(): Promise<OpsConfig | null> {
  try {
    return normalize(JSON.parse(await readFile(FILE, 'utf8')));
  } catch {
    return null;
  }
}

export async function getRegistrationPolicy(): Promise<RegistrationPolicy> {
  const cfg = await readConfig();
  if (cfg) return { open: cfg.registrationOpen, code: cfg.registrationCode, source: 'ops' };
  return { open: true, code: process.env.REGISTRATION_CODE?.trim() || null, source: 'env' };
}

/** code: undefined = keep, null = require none, string = require this one. */
export async function setRegistrationPolicy(patch: {
  open?: boolean;
  code?: string | null;
}): Promise<RegistrationPolicy> {
  return enqueue('config', async () => {
    // First write adopts the env default so flipping `open` alone does not
    // silently drop an env-configured code requirement.
    const cur = (await readConfig()) ?? {
      registrationOpen: true,
      registrationCode: process.env.REGISTRATION_CODE?.trim() || null,
    };
    if (patch.open !== undefined) cur.registrationOpen = patch.open;
    if (patch.code !== undefined)
      cur.registrationCode = patch.code ? patch.code.trim().slice(0, 64) : null;
    await mkdir(DATA_DIR, { recursive: true });
    await writeAtomic(FILE, JSON.stringify(cur));
    return { open: cur.registrationOpen, code: cur.registrationCode, source: 'ops' as const };
  });
}
