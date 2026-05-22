import { readFileSync, writeFileSync } from 'fs';
import { MODEL_DEFAULTS, ROUTER_MODEL_DEFAULTS } from './constants.js';

const SETTINGS_FILE = 'settings.json';

export const ENV_DEFAULTS = {
  provider: (process.env.AI_PROVIDER || 'deepseek').toLowerCase(),
  model: process.env.AI_MODEL || null,
  routerProvider: (process.env.ROUTER_PROVIDER || 'gemini').toLowerCase(),
  routerModel: process.env.ROUTER_MODEL || null,
};

const store = (() => {
  try { return JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')); }
  catch { return {}; }
})();

function save() {
  try { writeFileSync(SETTINGS_FILE, JSON.stringify(store, null, 2)); }
  catch (e) { console.warn('[settings] save failed:', e.message); }
}

export function getGuildSettings(guildId) {
  return { ...ENV_DEFAULTS, ...(store[guildId] ?? {}) };
}

export function updateGuildSettings(guildId, patch) {
  store[guildId] = { ...(store[guildId] ?? {}), ...patch };
  save();
  return getGuildSettings(guildId);
}

export function resetGuildSettings(guildId) {
  delete store[guildId];
  save();
  return { ...ENV_DEFAULTS };
}

export function resolveModel(provider, modelOverride) {
  return modelOverride || MODEL_DEFAULTS[provider] || 'deepseek-chat';
}

export function resolveRouterModel(routerProvider, modelOverride) {
  return modelOverride || ROUTER_MODEL_DEFAULTS[routerProvider] || 'gemini-2.5-flash-lite';
}

export { MODEL_DEFAULTS, ROUTER_MODEL_DEFAULTS };
