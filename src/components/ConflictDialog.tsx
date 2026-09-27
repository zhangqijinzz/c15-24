import { describeDocument, formatNumber } from '../domain';
import type { EnergyDocument, PendingConflict } from '../types';

interface ConflictDialogProps {
  conflict: PendingConflict;
  onResolve: (choice: 'local' | 'remote') => void;
}

export function ConflictDialog({ conflict, onResolve }: ConflictDialogProps) {
  return (
    <div className="conflict-backdrop" role="presentation">
      <div className="conflict-dialog" role="alertdialog" aria-modal="true" aria-labelledby="conflict-title" aria-describedby="conflict-desc">
        <div className="conflict-badge">!</div>
        <h2 id="conflict-title">其它标签页已经改动了方案</h2>
        <p id="conflict-desc">
          你在另一个标签页里也修改了同一份数据。为避免任何一方的内容被覆盖，
          请选择要保留的版本，另一份将被替换；选定后所有标签页都会自动同步。
        </p>

        <div className="conflict-options">
          <ConflictOption
            badge="本标签页"
            document={conflict.base}
            emphasis="你在本页刚刚做的修改"
            onClick={() => onResolve('local')}
          />
          {conflict.remote ? (
            <ConflictOption
              badge="其它标签页"
              document={conflict.remote}
              emphasis="其它标签页已保存的修改"
              onClick={() => onResolve('remote')}
            />
          ) : (
            <div className="conflict-option disabled">
              <span className="option-tag">其它标签页</span>
              <strong>数据已被清空</strong>
              <p>无法采用一个空版本，如不需要本页内容请手动清空。</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ConflictOption({ badge, document, emphasis, onClick }: { badge: string; document: EnergyDocument; emphasis: string; onClick: () => void }) {
  const outline = describeDocument(document);
  return (
    <button type="button" className="conflict-option" onClick={onClick}>
      <span className="option-tag">{badge}</span>
      <strong>{formatNumber(outline.totalMonthlyKwh)} <small>kWh / 月</small></strong>
      <p>{outline.scenarioCount} 个方案 · {outline.totalDevices} 台设备</p>
      <ul>
        {outline.scenarioNames.slice(0, 3).map((name, index) => <li key={index}>{name}</li>)}
        {outline.scenarioNames.length > 3 && <li>等 {outline.scenarioNames.length} 个方案</li>}
      </ul>
      <span className="option-action">保留{emphasis} →</span>
    </button>
  );
}
