import { exampleScenario } from './domain';
import { forceWriteEnvelope, readEnvelope, subscribeToExternalWrites, writeEnvelope, type WriteResult } from './services/storageService';
import type { EnergyDocument, EnergyScenario } from './types';

export type SaveOutcome =
  | { status: 'saved' }
  | { status: 'conflict'; current: EnergyDocument };

export interface EnergyRepository {
  load(): EnergyDocument;
  /** 带冲突检测的保存：发现其他标签页已写入新版本时返回冲突，不覆盖 */
  save(document: EnergyDocument): SaveOutcome;
  /** 用户确认"保留本页"后，强制以本页内容覆盖存储 */
  overwrite(document: EnergyDocument): SaveOutcome;
  /** 订阅其他标签页的写入；回调前内部修订号已同步 */
  onExternalChange(listener: (document: EnergyDocument) => void): () => void;
}

export class LocalEnergyRepository implements EnergyRepository {
  private revision = 0;

  load(): EnergyDocument {
    const envelope = readEnvelope();
    this.revision = envelope?.revision ?? 0;
    const saved = envelope?.document ?? null;
    if (!saved || saved.scenarios.length === 0) {
      return { version: 1, scenarios: [exampleScenario], activeScenarioId: exampleScenario.id };
    }
    const activeExists = saved.scenarios.some((scenario) => scenario.id === saved.activeScenarioId);
    return activeExists ? saved : { ...saved, activeScenarioId: saved.scenarios[0].id };
  }

  save(document: EnergyDocument): SaveOutcome {
    return this.adapt(writeEnvelope(document, this.revision));
  }

  overwrite(document: EnergyDocument): SaveOutcome {
    return this.adapt(forceWriteEnvelope(document));
  }

  onExternalChange(listener: (document: EnergyDocument) => void): () => void {
    return subscribeToExternalWrites((envelope) => {
      this.revision = envelope.revision;
      listener(envelope.document);
    });
  }

  private adapt(result: WriteResult): SaveOutcome {
    if (result.status === 'saved') {
      this.revision = result.revision;
      return { status: 'saved' };
    }
    // 冲突说明存储里已是更新的版本：先跟上它的修订号，
    // 这样用户选择"采用另一标签页的内容"后，下一次保存不会再误判冲突
    this.revision = result.current.revision;
    return { status: 'conflict', current: result.current.document };
  }
}

export function findScenario(document: EnergyDocument, id: string): EnergyScenario | undefined {
  return document.scenarios.find((scenario) => scenario.id === id);
}
