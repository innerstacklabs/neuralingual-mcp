/**
 * Tests for the partial-JSON framework parser. The implementation is a
 * port of `apps/web/lib/streaming/parse-partial-framework.ts` and the
 * logic is identical, but the tests are written independently against
 * the documented behavior in the implementation docstring so a refactor
 * doesn't silently change salvage semantics.
 */

import { describe, it, expect } from 'vitest';
import { parsePartialFramework } from './parse-partial-framework.js';

describe('parsePartialFramework', () => {
  it('returns {} for empty input', () => {
    expect(parsePartialFramework('')).toEqual({});
  });

  it('parses complete, valid JSON', () => {
    const input = JSON.stringify({
      methodology: 'Test',
      takeaway: 'Try things.',
    });
    const result = parsePartialFramework(input);
    expect(result.methodology).toBe('Test');
    expect(result.takeaway).toBe('Try things.');
  });

  it('returns {} for complete but non-object JSON (array root)', () => {
    expect(parsePartialFramework('[1, 2, 3]')).toEqual({});
  });

  it('returns {} for complete but non-object JSON (string root)', () => {
    expect(parsePartialFramework('"hello"')).toEqual({});
  });

  it('salvages an in-progress scalar string for `methodology`', () => {
    const buf = '{"methodology": "The practice of meeting';
    const result = parsePartialFramework(buf);
    expect(result.methodology).toBe('The practice of meeting');
  });

  it('salvages an in-progress scalar string for `takeaway`', () => {
    const buf = '{"takeaway": "Be curious about';
    const result = parsePartialFramework(buf);
    expect(result.takeaway).toBe('Be curious about');
  });

  it('truncates to last complete pair boundary when mid-nested-object', () => {
    const buf = '{"methodology":"done","principles":[{"name":"x","descript';
    const result = parsePartialFramework(buf);
    expect(result.methodology).toBe('done');
    // principles is incomplete → not returned.
    expect(result.principles).toBeUndefined();
  });

  it('truncates a trailing comma before the pair boundary', () => {
    const buf = '{"methodology":"done",';
    const result = parsePartialFramework(buf);
    expect(result.methodology).toBe('done');
  });

  it('does NOT salvage inside an incomplete \\u escape', () => {
    // \u requires 4 hex; here we have only 2 → salvage cuts BEFORE the \u.
    const buf = '{"methodology":"hi \\u12';
    const result = parsePartialFramework(buf);
    // Safe slice ends before the backslash: "hi "
    expect(result.methodology).toBe('hi ');
  });

  it('handles simple escaped chars in salvage', () => {
    const buf = '{"takeaway":"She said \\"hi\\" and';
    const result = parsePartialFramework(buf);
    expect(result.takeaway).toContain('She said');
  });

  it('returns {} when the buffer is structurally unparseable and has no recoverable pairs', () => {
    expect(parsePartialFramework('{"incomplete')).toEqual({});
  });
});
