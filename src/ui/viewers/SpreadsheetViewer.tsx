import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import './SpreadsheetViewer.css';

export interface SpreadsheetViewerProps {
  blobUrl: string;
  fileName: string;
}

const ROW_HEIGHT = 32;
const VISIBLE_BUFFER = 5;

function columnLabel(index: number): string {
  let label = '';
  let n = index;
  while (n >= 0) {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  }
  return label;
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value);
}

export function SpreadsheetViewer({ blobUrl, fileName: _fileName }: SpreadsheetViewerProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [workbook, setWorkbook] = useState<any>(null);
  const [activeSheet, setActiveSheet] = useState<string>('');
  const [data, setData] = useState<unknown[][]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Store XLSX module reference so we don't need require() in sync effects
  const xlsxRef = useRef<typeof import('xlsx') | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(600);

  // Load and parse workbook
  useEffect(() => {
    let cancelled = false;

    async function loadWorkbook() {
      try {
        setLoading(true);
        setError(null);

        const response = await fetch(blobUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch file: ${response.statusText}`);
        }
        const buffer = await response.arrayBuffer();

        const XLSX = await import('xlsx');
        xlsxRef.current = XLSX;
        const wb = XLSX.read(new Uint8Array(buffer), { type: 'array' });

        if (cancelled) return;

        setWorkbook(wb);
        const firstSheet = wb.SheetNames[0];
        if (firstSheet !== undefined) {
          setActiveSheet(firstSheet);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to parse spreadsheet');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadWorkbook();
    return () => { cancelled = true; };
  }, [blobUrl]);

  // Convert active sheet to array-of-arrays when sheet changes
  useEffect(() => {
    const XLSX = xlsxRef.current;
    if (!workbook || !activeSheet || !XLSX) {
      setData([]);
      return;
    }
    const sheet = workbook.Sheets[activeSheet];
    if (!sheet) {
      setData([]);
      return;
    }
    try {
      const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      setData(rows);
    } catch {
      setData([]);
    }
    setScrollTop(0);
  }, [workbook, activeSheet]);

  const columnCount = useMemo(() => {
    let max = 0;
    for (const row of data) {
      if (Array.isArray(row) && row.length > max) {
        max = row.length;
      }
    }
    return max;
  }, [data]);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (el) {
      setScrollTop(el.scrollTop);
    }
  }, []);

  // Track container size with ResizeObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    setContainerHeight(el.clientHeight);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setContainerHeight(entry.contentRect.height);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [loading]);

  // Virtual scroll calculations
  const totalHeight = data.length * ROW_HEIGHT;
  const startRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - VISIBLE_BUFFER);
  const endRow = Math.min(data.length, Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + VISIBLE_BUFFER);
  const visibleRows = data.slice(startRow, endRow);
  const offsetTop = startRow * ROW_HEIGHT;

  const sheetNames = workbook?.SheetNames as string[] | undefined;

  if (loading) {
    return (
      <div className="spreadsheet-viewer">
        <div className="spreadsheet-loading">
          <div className="spreadsheet-spinner" />
          <span>Parsing spreadsheet…</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="spreadsheet-viewer">
        <div className="spreadsheet-error">
          <span className="spreadsheet-error-icon">⚠️</span>
          <span>{error}</span>
        </div>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="spreadsheet-viewer">
        {sheetNames && sheetNames.length > 1 && (
          <div className="spreadsheet-tabs">
            {sheetNames.map((name) => (
              <button
                key={name}
                className={`spreadsheet-tab ${name === activeSheet ? 'active' : ''}`}
                onClick={() => setActiveSheet(name)}
              >
                {name}
              </button>
            ))}
          </div>
        )}
        <div className="spreadsheet-empty">
          <span>📊</span>
          <span>This sheet is empty</span>
        </div>
      </div>
    );
  }

  return (
    <div className="spreadsheet-viewer">
      {sheetNames && sheetNames.length > 1 && (
        <div className="spreadsheet-tabs">
          {sheetNames.map((name) => (
            <button
              key={name}
              className={`spreadsheet-tab ${name === activeSheet ? 'active' : ''}`}
              onClick={() => setActiveSheet(name)}
            >
              {name}
            </button>
          ))}
        </div>
      )}
      <div
        className="spreadsheet-scroll-container"
        ref={containerRef}
        onScroll={handleScroll}
      >
        <div style={{ height: totalHeight, position: 'relative' }}>
          <table className="spreadsheet-table">
            <thead>
              <tr>
                <th className="spreadsheet-row-header spreadsheet-corner">#</th>
                {Array.from({ length: columnCount }, (_, i) => (
                  <th key={i} className="spreadsheet-col-header">
                    {columnLabel(i)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody style={{ transform: `translateY(${offsetTop}px)` }}>
              {visibleRows.map((row, i) => {
                const rowIndex = startRow + i;
                const cells = Array.isArray(row) ? row : [];
                return (
                  <tr key={rowIndex} className={rowIndex % 2 === 0 ? 'even' : 'odd'}>
                    <td className="spreadsheet-row-header">{rowIndex + 1}</td>
                    {Array.from({ length: columnCount }, (_, colIdx) => (
                      <td key={colIdx} className="spreadsheet-cell">
                        <span className="spreadsheet-cell-content">
                          {formatCellValue(cells[colIdx])}
                        </span>
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <div className="spreadsheet-status-bar">
        {data.length.toLocaleString()} rows × {columnCount} columns
        {sheetNames && sheetNames.length > 1 && ` · Sheet: ${activeSheet}`}
      </div>
    </div>
  );
}

export default SpreadsheetViewer;
