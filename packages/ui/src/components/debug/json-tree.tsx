'use client';

import { useState } from 'react';

interface JsonTreeProps {
  data: unknown;
  defaultExpanded?: boolean;
  maxStringLength?: number;
}

export function JsonTree({ data, defaultExpanded = false, maxStringLength = 200 }: JsonTreeProps) {
  const json = typeof data === 'string' ? data : JSON.stringify(data, null, 2);

  if (!json || json === '{}' || json === 'null' || json === 'undefined') {
    return <span className="text-zinc-500 italic">empty</span>;
  }

  const truncated = json.length > maxStringLength && !defaultExpanded;

  return <JsonBlock content={json} truncated={truncated} maxLength={maxStringLength} />;
}

function JsonBlock({ content, truncated, maxLength }: { content: string; truncated: boolean; maxLength: number }) {
  const [expanded, setExpanded] = useState(false);

  const display = expanded || !truncated ? content : content.slice(0, maxLength) + '...';

  return (
    <div className="relative">
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-black/30 p-2 font-mono text-[11px] leading-relaxed text-zinc-300">
        {display}
      </pre>
      {truncated && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-[10px] text-indigo-400 hover:text-indigo-300"
        >
          {expanded ? 'Collapse' : `Show all (${content.length} chars)`}
        </button>
      )}
    </div>
  );
}
