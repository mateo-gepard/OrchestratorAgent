import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const IS_VERCEL = Boolean(process.env.VERCEL);
export const DATA_ROOT =
  process.env.MAESTRO_DATA_DIR || (IS_VERCEL ? path.join(os.tmpdir(), 'maestro-data') : path.join(PROJECT_ROOT, 'data'));
