import { exampleScenario } from './domain';
import {
  DocumentConflictError,
  STORAGE_KEY,
  commitStoredDocument,
  forceWriteDocument,
  parseStoredRaw,
  readStoredDocument,
} from './services/storageService';
import type { EnergyDocument, EnergyScenario } from './types';

export { DocumentConflictError };

export interface RemoteChange {
  revision: number;
  document: EnergyDocument | null;
}

export interface EnergyRepository {
  load(): { document: EnergyDocument; revision: number };
  /** 乐观锁保存：基于给定版本提交，被其它标签页抢先时抛出 DocumentConflictError。 */
  save(document: EnergyDocument, baseRevision: number): { revision: number };
  /** 冲突解决后强制写入指定版本。 */
  forceSave(document: EnergyDocument, remoteRevision: number): { revision: number };
  /** 订阅其它标签页的写入（BroadcastChannel 实时通道 + storage 事件兜底）。 */
  subscribe(listener: (change: RemoteChange) => void): () => void;
}

interface LedgerEntry {
  revision: number;
  raw: string | null;
}

export class LocalEnergyRepository implements EnergyRepository {
  /**
   * 本页已知的最新存储原样内容。单标签页自动保存时 getItem 与此处相等，
   * 直接走快速路径，省掉解析，体验与旧的无条件写一致。
   */
  private ledger: LedgerEntry = { revision: 0, raw: null };
  private readonly listeners = new Set<(change: RemoteChange) => void>();
  private readonly channel: BroadcastChannel | null;

  constructor() {
    this.channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(STORAGE_KEY) : null;
    this.channel?.addEventListener('message', (event: MessageEvent<RemoteChange>) => {
      if (!event.data || typeof event.data.revision !== 'number') return;
      // 发送方已完成写入，顺手刷新账本，让本页下一次保存继续走快速路径。
      const stored = readStoredDocument();
      if (stored) this.ledger = { revision: stored.revision, raw: stored.raw };
      this.dispatch(event.data);
    });
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', this.handleStorageEvent);
    }
  }

  load(): { document: EnergyDocument; revision: number } {
    const saved = readStoredDocument();
    if (saved) this.ledger = { revision: saved.revision, raw: saved.raw };

    if (!saved || saved.document.scenarios.length === 0) {
      return { document: { version: 1, scenarios: [exampleScenario], activeScenarioId: exampleScenario.id }, revision: this.ledger.revision };
    }
    const activeExists = saved.document.scenarios.some((scenario) => scenario.id === saved.document.activeScenarioId);
    const document = activeExists ? saved.document : { ...saved.document, activeScenarioId: saved.document.scenarios[0].id };
    return { document, revision: saved.revision };
  }

  save(document: EnergyDocument, baseRevision: number): { revision: number } {
    const result = commitStoredDocument(document, this.ledger.raw, baseRevision);
    this.ledger = { revision: result.entry.revision, raw: result.raw };
    this.broadcast({ revision: result.entry.revision, document });
    return { revision: result.entry.revision };
  }

  forceSave(document: EnergyDocument, remoteRevision: number): { revision: number } {
    const result = forceWriteDocument(document, remoteRevision);
    this.ledger = { revision: result.entry.revision, raw: result.raw };
    this.broadcast({ revision: result.entry.revision, document });
    return { revision: result.entry.revision };
  }

  subscribe(listener: (change: RemoteChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private readonly handleStorageEvent = (event: StorageEvent): void => {
    // storage 事件天然不在写入页触发，是跨标签页兜底通道（BroadcastChannel 不被支持时仍可感知）。
    if (event.key !== STORAGE_KEY) return;
    const entry = parseStoredRaw(event.newValue);
    const change: RemoteChange = entry ? { revision: entry.revision, document: entry.document } : { revision: 0, document: null };
    this.ledger = { revision: change.revision, raw: event.newValue };
    this.dispatch(change);
  };

  private dispatch(change: RemoteChange): void {
    this.listeners.forEach((listener) => listener(change));
  }

  private broadcast(change: RemoteChange): void {
    this.channel?.postMessage(change);
  }
}

export function findScenario(document: EnergyDocument, id: string): EnergyScenario | undefined {
  return document.scenarios.find((scenario) => scenario.id === id);
}
