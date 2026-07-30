import { describe, it, expect } from 'vitest';
import {
  renderFrameworkMarkdown,
  extractFrameworkSchemaVersion,
  extractFrameworkTakeaway,
  hasFramework,
  NO_FRAMEWORK_MESSAGE,
  type FrameworkLike,
} from './framework-render.js';

const completeFramework: FrameworkLike = {
  schemaVersion: 1,
  methodology:
    'Draws on contemporary cognitive-behavioral research, trauma-informed somatic practice, and stoic philosophical grounding.',
  principles: [
    { name: 'Self-compassion', description: 'Meet difficulty with warmth, not judgment.' },
    { name: 'Agency', description: 'Choose the next small step.' },
    { name: 'Grounding', description: 'Anchor to the body and present moment.' },
  ],
  sources: [
    { name: 'Kristin Neff', work: 'Self-Compassion', contribution: 'Framework for self-kindness.' },
    { name: 'Epictetus', work: null, contribution: 'Locus-of-control distinction.' },
  ],
  groupings: [
    { name: 'Opening', purpose: 'Soften into awareness.' },
    { name: 'Anchoring', purpose: 'Stabilize attention.' },
  ],
  terminology: [
    { term: 'Locus of control', definition: 'What is mine to act on vs what is not.' },
  ],
  practical_application: 'Use twice daily, morning and evening, 10 minutes each.',
  takeaway: 'Small consistent practice compounds into calm.',
};

describe('renderFrameworkMarkdown', () => {
  it('renders all sections for a complete framework', () => {
    const md = renderFrameworkMarkdown(completeFramework);
    expect(md).toContain('# Framework');
    expect(md).toContain('## Methodology');
    expect(md).toContain('Draws on contemporary cognitive-behavioral');
    expect(md).toContain('## Principles');
    expect(md).toContain('- **Self-compassion** — Meet difficulty with warmth');
    expect(md).toContain('## Sources');
    expect(md).toContain('- **Kristin Neff** _(from Self-Compassion)_ — Framework for self-kindness.');
    // Epictetus has work: null — no _(from ...)_ suffix
    expect(md).toContain('- **Epictetus** — Locus-of-control distinction.');
    expect(md).not.toContain('(from null)');
    expect(md).toContain('## Groupings');
    expect(md).toContain('- **Opening** — Soften into awareness.');
    expect(md).toContain('## Terminology');
    expect(md).toContain('- **Locus of control** — What is mine to act on vs what is not.');
    expect(md).toContain('## Practical Application');
    expect(md).toContain('## Takeaway');
    expect(md).toContain('> Small consistent practice compounds into calm.');
  });

  it('ends with a single trailing newline', () => {
    const md = renderFrameworkMarkdown(completeFramework);
    expect(md.endsWith('\n')).toBe(true);
    expect(md.endsWith('\n\n')).toBe(false);
  });

  it('omits terminology section when absent', () => {
    const rest = { ...completeFramework };
    delete (rest as Record<string, unknown>)['terminology'];
    const md = renderFrameworkMarkdown(rest);
    expect(md).not.toContain('## Terminology');
    // Adjacent sections still render
    expect(md).toContain('## Groupings');
    expect(md).toContain('## Practical Application');
  });

  it('omits terminology section when empty array', () => {
    const md = renderFrameworkMarkdown({ ...completeFramework, terminology: [] });
    expect(md).not.toContain('## Terminology');
  });

  it('omits terminology section when null', () => {
    const md = renderFrameworkMarkdown({ ...completeFramework, terminology: null });
    expect(md).not.toContain('## Terminology');
  });

  it('does NOT include a standalone --- horizontal rule (YAML boundary safety)', () => {
    const md = renderFrameworkMarkdown(completeFramework);
    expect(md).not.toMatch(/^---\s*$/m);
  });

  it('returns fallback message when framework is null', () => {
    expect(renderFrameworkMarkdown(null)).toBe(NO_FRAMEWORK_MESSAGE);
  });

  it('returns fallback message when framework is undefined', () => {
    expect(renderFrameworkMarkdown(undefined)).toBe(NO_FRAMEWORK_MESSAGE);
  });

  it('returns fallback message when framework is non-object', () => {
    expect(renderFrameworkMarkdown('not a framework')).toBe(NO_FRAMEWORK_MESSAGE);
    expect(renderFrameworkMarkdown(42)).toBe(NO_FRAMEWORK_MESSAGE);
  });

  it('tolerates missing principles array without crashing', () => {
    const rest = { ...completeFramework };
    delete (rest as Record<string, unknown>)['principles'];
    const md = renderFrameworkMarkdown(rest);
    expect(md).not.toContain('## Principles');
    expect(md).toContain('## Methodology');
  });

  it('tolerates empty principles array without emitting an empty section', () => {
    const md = renderFrameworkMarkdown({ ...completeFramework, principles: [] });
    expect(md).not.toContain('## Principles');
  });

  it('tolerates malformed source entries (missing fields)', () => {
    const md = renderFrameworkMarkdown({
      ...completeFramework,
      sources: [
        { name: 'Clean source', work: null, contribution: 'Works.' },
        { name: 'No contribution', work: null }, // missing contribution
        { work: 'orphan work' }, // no name, no contribution
        null, // garbage
        'scalar', // garbage
      ] as unknown[],
    });
    expect(md).toContain('## Sources');
    expect(md).toContain('- **Clean source** — Works.');
    expect(md).toContain('- **No contribution**'); // rendered with just name
  });

  it('renders a bare-minimum framework with only a takeaway', () => {
    const md = renderFrameworkMarkdown({ takeaway: 'Minimum viable.' });
    expect(md).toContain('# Framework');
    expect(md).toContain('> Minimum viable.');
    expect(md).not.toContain('## Methodology');
  });

  it('tolerates blank-string fields (treats as missing)', () => {
    const md = renderFrameworkMarkdown({
      ...completeFramework,
      methodology: '   ',
      takeaway: '',
    });
    expect(md).not.toContain('## Methodology');
    expect(md).not.toContain('## Takeaway');
  });
});

describe('hasFramework', () => {
  it('returns true for an object', () => {
    expect(hasFramework({ takeaway: 'x' })).toBe(true);
  });
  it('returns false for null / undefined / non-object', () => {
    expect(hasFramework(null)).toBe(false);
    expect(hasFramework(undefined)).toBe(false);
    expect(hasFramework('')).toBe(false);
    expect(hasFramework(42)).toBe(false);
  });
});

describe('extractFrameworkSchemaVersion', () => {
  it('returns the numeric schemaVersion when present', () => {
    expect(extractFrameworkSchemaVersion({ schemaVersion: 1 })).toBe(1);
  });
  it('returns null when absent', () => {
    expect(extractFrameworkSchemaVersion({})).toBeNull();
  });
  it('returns null for non-number schemaVersion', () => {
    expect(extractFrameworkSchemaVersion({ schemaVersion: '1' })).toBeNull();
  });
  it('returns null for null framework', () => {
    expect(extractFrameworkSchemaVersion(null)).toBeNull();
  });
});

describe('extractFrameworkTakeaway', () => {
  it('returns the takeaway when non-empty string', () => {
    expect(extractFrameworkTakeaway({ takeaway: 'hello' })).toBe('hello');
  });
  it('returns null when empty string', () => {
    expect(extractFrameworkTakeaway({ takeaway: '' })).toBeNull();
  });
  it('returns null when absent', () => {
    expect(extractFrameworkTakeaway({})).toBeNull();
  });
  it('returns null when framework is null', () => {
    expect(extractFrameworkTakeaway(null)).toBeNull();
  });
});
