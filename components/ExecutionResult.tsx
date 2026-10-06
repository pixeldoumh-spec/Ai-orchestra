import type { ReactNode } from "react";

type Props = {
  value: unknown;
};

type TableData = {
  columns: string[];
  rows: unknown[][];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function scalarText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function asTable(value: unknown): TableData | null {
  if (isRecord(value)) {
    const table = isRecord(value.table) ? value.table : value;
    const columns = Array.isArray(table.columns)
      ? table.columns.map((column) => String(column))
      : null;
    const rows = Array.isArray(table.rows)
      ? table.rows
      : null;
    if (columns && rows) {
      return {
        columns,
        rows: rows.map((row) => Array.isArray(row) ? row : [row]),
      };
    }
  }

  if (Array.isArray(value) && value.length > 0 && value.every(isRecord)) {
    const keys: string[] = [];
    for (const row of value) {
      for (const key of Object.keys(row)) {
        if (!keys.includes(key)) keys.push(key);
      }
    }
    if (keys.length > 0) {
      return {
        columns: keys,
        rows: value.map((row) => keys.map((key) => row[key])),
      };
    }
  }

  return null;
}

function unwrap(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if ("result" in value) return value.result;
  if (typeof value.content === "string") return value.content;
  if (typeof value.body === "string") return value.body;
  return value;
}

function renderInlineValue(value: unknown): ReactNode {
  if (value === null || value === undefined) return <span className="resultNull">—</span>;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return <code>{JSON.stringify(value)}</code>;
}

function renderTable(table: TableData): ReactNode {
  return (
    <div className="executionTableWrap">
      <table className="executionTable">
        <thead>
          <tr>
            {table.columns.map((column) => <th key={column}>{column}</th>)}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {table.columns.map((_, columnIndex) => (
                <td key={columnIndex}>{renderInlineValue(row[columnIndex])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function splitMarkdownRow(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}

function renderMarkdown(text: string): ReactNode {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const body = paragraph.join(" ").trim();
    if (body) blocks.push(<p key={blocks.length} className="executionParagraph">{body}</p>);
    paragraph = [];
  };

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      index += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      flushParagraph();
      const language = trimmed.slice(3).trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        <pre key={blocks.length} className="executionCode">
          {language && <span className="executionCodeLang">{language}</span>}
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    if (/^#{1,3}\s+/.test(trimmed)) {
      flushParagraph();
      const match = /^(#{1,3})\s+(.+)$/.exec(trimmed);
      const level = match?.[1].length ?? 2;
      const title = match?.[2] ?? trimmed;
      const Tag = level === 1 ? "h3" : level === 2 ? "h4" : "h5";
      blocks.push(<Tag key={blocks.length} className="executionHeading">{title}</Tag>);
      index += 1;
      continue;
    }

    if ((trimmed.startsWith("|") || trimmed.includes("|")) && index + 1 < lines.length && isMarkdownTableSeparator(lines[index + 1])) {
      flushParagraph();
      const columns = splitMarkdownRow(line);
      const rows: unknown[][] = [];
      index += 2;
      while (index < lines.length) {
        const rowLine = lines[index];
        if (!rowLine.trim() || !rowLine.includes("|")) break;
        rows.push(splitMarkdownRow(rowLine));
        index += 1;
      }
      blocks.push(renderTable({ columns, rows }));
      continue;
    }

    const bullet = /^(?:[-*]|\u2022)\s+(.+)$/.exec(trimmed);
    if (bullet) {
      flushParagraph();
      const items: string[] = [];
      while (index < lines.length) {
        const match = /^(?:[-*]|\u2022)\s+(.+)$/.exec(lines[index].trim());
        if (!match) break;
        items.push(match[1]);
        index += 1;
      }
      blocks.push(
        <ul key={blocks.length} className="executionList">
          {items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}
        </ul>,
      );
      continue;
    }

    const ordered = /^\d+[.)]\s+(.+)$/.exec(trimmed);
    if (ordered) {
      flushParagraph();
      const items: string[] = [];
      while (index < lines.length) {
        const match = /^\d+[.)]\s+(.+)$/.exec(lines[index].trim());
        if (!match) break;
        items.push(match[1]);
        index += 1;
      }
      blocks.push(
        <ol key={blocks.length} className="executionList">
          {items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}
        </ol>,
      );
      continue;
    }

    paragraph.push(trimmed);
    index += 1;
  }

  flushParagraph();
  return blocks.length > 0 ? blocks : <p className="executionParagraph">No presentation content returned.</p>;
}

export function ExecutionResult({ value }: Props) {
  const payload = unwrap(value);
  const table = asTable(payload);

  return (
    <div className="executionResult">
      {table
        ? renderTable(table)
        : typeof payload === "string"
          ? renderMarkdown(payload)
          : Array.isArray(payload)
            ? <ul className="executionList">{payload.map((item, index) => <li key={index}>{renderInlineValue(item)}</li>)}</ul>
            : isRecord(payload)
              ? <div className="executionObject">{Object.entries(payload).map(([key, item]) => (
                  <div className="executionField" key={key}>
                    <span className="executionFieldLabel">{key.replace(/[_-]+/g, " ")}</span>
                    <div className="executionFieldValue">
                      {typeof item === "string" ? renderMarkdown(item) : renderInlineValue(item)}
                    </div>
                  </div>
                ))}</div>
              : <pre className="executionCode"><code>{scalarText(payload)}</code></pre>}
    </div>
  );
}
