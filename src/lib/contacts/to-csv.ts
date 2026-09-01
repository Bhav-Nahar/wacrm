/**
 * CSV serialisation for the contacts export.
 *
 * Columns deliberately mirror what {@link parseContactCsv} accepts, so an
 * export can be edited in a spreadsheet and fed straight back through
 * Import without a column-mapping step.
 */

export interface ExportableContact {
  phone: string;
  name?: string;
  email?: string;
  company?: string;
  tags?: { name: string }[];
}

export const CONTACT_CSV_HEADERS = [
  'phone',
  'name',
  'email',
  'company',
  'tags',
] as const;

/**
 * Quote a single cell.
 *
 * The leading-apostrophe case is not cosmetic: contact names and company
 * fields come from customers, and a cell starting with `=`, `+`, `-` or
 * `@` is executed as a formula when the file is opened in Excel or
 * Sheets. Prefixing neutralises it (CSV injection / CWE-1236).
 */
function escapeCell(value: string | undefined): string {
  let cell = value ?? '';
  if (/^[=+\-@\t\r]/.test(cell)) cell = `'${cell}`;
  if (/[",\n\r]/.test(cell)) cell = `"${cell.replace(/"/g, '""')}"`;
  return cell;
}

export function contactsToCsv(contacts: ExportableContact[]): string {
  const rows = [CONTACT_CSV_HEADERS.join(',')];

  for (const c of contacts) {
    rows.push(
      [
        escapeCell(c.phone),
        escapeCell(c.name),
        escapeCell(c.email),
        escapeCell(c.company),
        // Semicolons, not commas: the importer splits on either, and a
        // semicolon survives a spreadsheet round-trip without needing
        // the whole cell quoted.
        escapeCell((c.tags ?? []).map((t) => t.name).join('; ')),
      ].join(','),
    );
  }

  // Trailing newline: POSIX text files end in one, and its absence makes
  // some tools drop the last row.
  return rows.join('\n') + '\n';
}
