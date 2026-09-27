import type { EnergyDocument } from '../types';

export const STORAGE_KEY = 'energy-lens.document.v1';

/** 持久化信封：业务数据外包裹一个单调递增的版本号，用于跨标签页乐观锁。 */
export interface StoredEnvelope {
  format: 'energy-lens.document';
  revision: number;
  document: EnergyDocument;
}

/** 读取结果附带原始字符串，调用方可原样比对，避免热路径重复 JSON.parse。 */
export interface StoredEntry {
  revision: number;
  document: EnergyDocument;
  raw: string;
}

/**
 * 提交时发现存储版本已不是本页持有的版本：另一个标签页先写入了。
 * 调用方必须让用户决定保留哪一份，绝不允许静默覆盖。
 */
export class DocumentConflictError extends Error {
  readonly remote: StoredEntry | null;

  constructor(remote: StoredEntry | null) {
    super('document revision conflict');
    this.name = 'DocumentConflictError';
    this.remote = remote;
  }
}

/** 读取当前存储内容；存储为空时返回 null（损坏或无法解析也按空处理）。 */
export function readStoredDocument(): StoredEntry | null {
  return parseStoredEntry(safeGetRaw());
}

/**
 * 比较并交换：仅当存储内容仍等于 baseRaw（通常是本页上次同步到的原样内容）时才写入。
 *
 * 单标签页热路径下 baseRaw 就是上次写入的字符串，storage getItem === baseRaw，
 * 成本与旧的“无条件写”完全一致：一次读 + 一次写，无额外解析。
 * 真正发生跨标签页竞争时才走慢路径解析远端版本，抛出冲突供上层决策。
 */
export function commitStoredDocument(document: EnergyDocument, baseRaw: string | null, baseRevision: number): { entry: StoredEntry; raw: string } {
  const currentRaw = safeGetRaw();

  if (currentRaw === baseRaw) {
    const raw = writeEnvelope(document, baseRevision + 1);
    return { entry: { revision: baseRevision + 1, document, raw }, raw };
  }

  const remote = parseStoredEntry(currentRaw);
  // 远端版本必须严格更新才算冲突；相同或更旧的重放（事件重复投递等）不阻断提交。
  if (!remote || remote.revision > baseRevision) {
    throw new DocumentConflictError(remote);
  }
  // 远端内容相同或更旧（理论上不该出现），直接以本页为准覆盖。
  const raw = writeEnvelope(document, remote.revision + 1);
  return { entry: { revision: remote.revision + 1, document, raw }, raw };
}

/** 冲突解决后强制写入：以本页决定的版本为准，并在其基础上推进版本号。 */
export function forceWriteDocument(document: EnergyDocument, remoteRevision: number): { entry: StoredEntry; raw: string } {
  const raw = writeEnvelope(document, remoteRevision + 1);
  return { entry: { revision: remoteRevision + 1, document, raw }, raw };
}

function writeEnvelope(document: EnergyDocument, revision: number): string {
  const envelope: StoredEnvelope = { format: 'energy-lens.document', revision, document };
  const raw = JSON.stringify(envelope);
  localStorage.setItem(STORAGE_KEY, raw);
  return raw;
}

function safeGetRaw(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** 解析一段存储原文（信封或 v1 裸文档），供事件处理器等复用。 */
export function parseStoredRaw(raw: string | null): StoredEntry | null {
  return parseStoredEntry(raw);
}

function parseStoredEntry(raw: string | null): StoredEntry | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const envelope = asEnvelope(parsed);
    if (envelope) return { revision: envelope.revision, document: envelope.document, raw };
    // 兼容 v1 旧格式：裸文档，版本号视为 0，首次保存会迁移为信封。
    if (isDocument(parsed)) return { revision: 0, document: parsed, raw };
    return null;
  } catch {
    return null;
  }
}

function asEnvelope(value: unknown): StoredEnvelope | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<StoredEnvelope>;
  if (candidate.format !== 'energy-lens.document') return null;
  if (typeof candidate.revision !== 'number' || candidate.revision < 0) return null;
  return isDocument(candidate.document) ? { format: 'energy-lens.document', revision: candidate.revision, document: candidate.document } : null;
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
