import { describe, it, expect } from 'vitest';
import { contactsToCsv } from './to-csv';
import { parseContactCsv } from './parse-contact-csv';

describe('contactsToCsv', () => {
  it('writes the header even with no rows', () => {
    expect(contactsToCsv([])).toBe('phone,name,email,company,tags\n');
  });

  it('quotes cells containing commas, quotes or newlines', () => {
    const csv = contactsToCsv([
      { phone: '+123', name: 'Doe, Jane', company: 'He said "hi"' },
    ]);
    expect(csv).toContain('"Doe, Jane"');
    expect(csv).toContain('"He said ""hi"""');
  });

  it('neutralises formula-injection payloads', () => {
    const csv = contactsToCsv([{ phone: '+123', name: '=cmd|/c calc' }]);
    expect(csv).toContain(`'=cmd|/c calc`);
  });

  it('round-trips back through the importer', () => {
    const csv = contactsToCsv([
      {
        phone: '+15551234567',
        name: 'Jane Doe',
        email: 'jane@example.com',
        company: 'Acme, Inc',
        tags: [{ name: 'vip' }, { name: 'lead' }],
      },
    ]);

    const { rows } = parseContactCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].phone).toBe('+15551234567');
    expect(rows[0].name).toBe('Jane Doe');
    expect(rows[0].company).toBe('Acme, Inc');
    expect(rows[0].tagNames).toEqual(['vip', 'lead']);
  });
});
