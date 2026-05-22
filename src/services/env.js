import dotenv from 'dotenv';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

// Prefer the repository .env over stale variables inherited from an old shell.
const here = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(here, '../../.env'), override: true });
