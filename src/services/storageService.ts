import type { EnergyDocument } from '../types';

const STORAGE_KEY = 'energy-lens.document.v1';

/** 存储信封：在文档外层带上修订号与写入标记，用于多标签页并发检测 */
export interface Envelope {
  revision: number;
  writeId: string;
  document: EnergyDocument;
}

export type WriteResult =
  | { status: 'saved'; revision: number }
  | { status: 'conflict'; current: Envelope };

export function readEnvelope(): Envelope | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (isEnvelope(parsed)) return parsed;
    // 兼容旧版存储：裸文档视为第 0 版
    if (isDocument(parsed)) return { revision: 0, writeId: 'legacy', document: parsed };
    return null;
  } catch {
    return null;
  }
}

/** 兼容旧接口：只取文档部分 */
export function readDocument(): EnergyDocument | null {
  return readEnvelope()?.document ?? null;
}

/**
 * 带冲突检测的写入：仅当存储中的修订号仍等于 baseRevision 时才落盘，
 * 否则返回冲突与存储中的当前内容，绝不静默覆盖其他标签页的改动。
 */
export function writeEnvelope(document: EnergyDocument, baseRevision: number): WriteResult {
  const current = readEnvelope();
  if (current && current.revision !== baseRevision) {
    return { status: 'conflict', current };
  }
  const revision = Math.max(current?.revision ?? 0, baseRevision) + 1;
  const writeId = makeWriteId();
  const envelope: Envelope = { revision, writeId, document };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
  // 写后立即读回校验：若两份写入恰好撞在一起，存储里必须是完整的一份；
  // 发现不是自己写入的内容时按冲突处理，而不是误以为保存成功。
  const verified = readEnvelope();
  if (!verified || verified.writeId !== writeId) {
    return { status: 'conflict', current: verified ?? envelope };
  }
  return { status: 'saved', revision };
}

/** 用户明确选择"保留本页"后的强制写入：基于存储最新修订号落盘，偶发撞车时重试 */
export function forceWriteEnvelope(document: EnergyDocument): WriteResult {
  let last: WriteResult = { status: 'conflict', current: { revision: 0, writeId: '', document } };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const base = readEnvelope()?.revision ?? 0;
    const result = writeEnvelope(document, base);
    if (result.status === 'saved') return result;
    last = result;
  }
  return last;
}

/** 监听其他标签页的写入（storage 事件不会在本页自己写入时触发，单标签页时零打扰） */
export function subscribeToExternalWrites(listener: (envelope: Envelope) => void): () => void {
  const handler = (event: StorageEvent) => {
    if (event.key !== null && event.key !== STORAGE_KEY) return;
    const envelope = readEnvelope();
    if (envelope) listener(envelope);
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}

function makeWriteId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isEnvelope(value: unknown): value is Envelope {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Envelope>;
  return typeof candidate.revision === 'number'
    && typeof candidate.writeId === 'string'
    && isDocument(candidate.document);
}

function isDocument(value: unknown): value is EnergyDocument {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<EnergyDocument>;
  return candidate.version === 1
    && typeof candidate.activeScenarioId === 'string'
    && Array.isArray(candidate.scenarios)
    && candidate.scenarios.length > 0
    && candidate.scenarios.every(isScenario)
    && candidate.scenarios.some((scenario) => scenario.id === candidate.activeScenarioId);
}

function isScenario(value: unknown): value is EnergyDocument['scenarios'][number] {
  if (!value || typeof value !== 'object') return false;
  const scenario = value as Partial<EnergyDocument['scenarios'][number]>;
  return typeof scenario.id === 'string'
    && typeof scenario.name === 'string'
    && typeof scenario.createdAt === 'string'
    && typeof scenario.pricePerKwh === 'number'
    && scenario.pricePerKwh >= 0
    && typeof scenario.daysPerMonth === 'number'
    && scenario.daysPerMonth >= 1
    && scenario.daysPerMonth <= 31
    && Array.isArray(scenario.devices)
    && scenario.devices.length > 0
    && scenario.devices.every(isDevice);
}

function isDevice(value: unknown): value is EnergyDocument['scenarios'][number]['devices'][number] {
  if (!value || typeof value !== 'object') return false;
  const device = value as Partial<EnergyDocument['scenarios'][number]['devices'][number]>;
  return typeof device.id === 'string'
    && typeof device.name === 'string'
    && typeof device.watts === 'number'
    && device.watts >= 0
    && typeof device.dailyHours === 'number'
    && device.dailyHours >= 0
    && device.dailyHours <= 24;
}
