/**
 * The panel's marks for where a selection departs from its style profile (DSK-224).
 * Real panel, stores and shape definitions: the rows are hand-written across two
 * render paths, so the only way to know one is marked is to render it.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import '../../shapes/Rectangle';
import '../../shapes/Ellipse';
import '../../shapes/Line';
import '../../shapes/Connector';
import '../../shapes/Text';
import '../../shapes/Group';
import '../../shapes/FileShape';
import { shapeRegistry } from '../../shapes/ShapeRegistry';
import { createLibraryShapeHandler } from '../../shapes/library/LibraryShapeHandler';
import { activityActionShape, activitySwimlaneShape } from '../../shapes/library/activityDiagramShapes';
import { erdEntityShape } from '../../shapes/library/erdShapes';
import { PropertyPanel } from '../PropertyPanel';
import { useDocumentStore } from '../../store/documentStore';
import { useHistoryStore } from '../../store/historyStore';
import { usePageStore } from '../../store/pageStore';
import { useSessionStore } from '../../store/sessionStore';
import { STYLE_FACETS } from '../../store/styleProfile';
import {
  getProfileUpdates,
  profileDepartures,
  useStyleProfileStore,
  type StyleProfile,
} from '../../store/styleProfileStore';
import type { Shape } from '../../shapes/Shape';

const BASE = {
  fill: '#101010',
  stroke: '#202020',
  strokeWidth: 3,
  opacity: 0.5,
  cornerRadius: 4,
  labelFontSize: 11,
  labelColor: '#303030',
  fontSize: 15,
  fontFamily: 'serif',
  startArrow: 'arrow',
  endArrow: 'arrow',
  lineStyle: 'dashed',
  backgroundColor: '#404040',
  borderColor: '#505050',
  borderWidth: 2,
  rowSeparatorColor: '#606060',
  rowBackgroundColor: '#616161',
  rowAlternateColor: '#626262',
  attributePaddingHorizontal: 5,
  attributePaddingVertical: 6,
  headerBackground: '#707070',
  separatorColor: '#717171',
  separatorWidth: 2,
  iconId: 'star',
  iconSize: 20,
  iconPadding: 4,
  iconColor: '#808080',
  iconPosition: 'top-left',
  iconDisplayMode: 'badge',
  iconBadge: { shape: 'circle', backgroundColor: '#909090' },
};
const WITH_ICONS = { ...BASE, icons: [{ id: 'one', iconId: 'star', size: 20, position: 'center' }] };

const profileWith = (properties: object): StyleProfile => ({
  id: 'probe',
  name: 'Probe',
  properties,
  createdAt: 0,
  updatedAt: 0,
}) as unknown as StyleProfile;

const SIZE = { x: 0, y: 0, width: 100, height: 60, rotation: 0, locked: false, visible: true };
const FIXTURES: Record<string, { shape: object; properties?: object }> = {
  rectangle: { shape: { type: 'rectangle', cornerRadius: 0, label: 'L' } },
  'rectangle with icons': { shape: { type: 'rectangle', cornerRadius: 0, label: 'L' }, properties: WITH_ICONS },
  ellipse: { shape: { type: 'ellipse', label: 'L' } },
  line: { shape: { type: 'line', x2: 100, y2: 100, startArrow: 'none', endArrow: 'none' } },
  connector: { shape: { type: 'connector', x2: 100, y2: 100, label: 'L' } },
  text: { shape: { type: 'text', text: 'T', fontSize: 12, fontFamily: 'sans-serif', textAlign: 'left' } },
  group: { shape: { type: 'group', childIds: [], label: 'L', showBackground: true } },
  file: { shape: { type: 'file', blobRef: 'x', fileName: 'a.txt', mimeType: 'text/plain', fileSize: 1, fileCategory: 'text', label: 'L' } },
  'library shape': { shape: { type: activityActionShape.type, label: 'L' } },
  'library shape with icons': { shape: { type: activityActionShape.type, label: 'L' }, properties: WITH_ICONS },
  swimlane: { shape: { type: activitySwimlaneShape.type, customProperties: { lanes: [] } } },
  'ERD entity': { shape: { type: erdEntityShape.type, customProperties: { rowSeparatorEnabled: true } } },
};

function otherThan(value: unknown): unknown {
  if (typeof value === 'number') return value + 1;
  if (typeof value === 'string') return value.startsWith('#') ? '#000001' : `${value}-other`;
  if (Array.isArray(value)) return value.map((item: object) => ({ ...item, size: 99 }));
  return { ...(value as object), shape: 'square' };
}

function departing(shape: Shape, name: string): Partial<Shape> {
  const record = shape as unknown as Record<string, unknown>;
  if (!name.startsWith('customProperties.')) return { [name]: otherThan(record[name]) } as Partial<Shape>;
  const field = name.slice('customProperties.'.length);
  const data = record['customProperties'] as Record<string, unknown>;
  return { customProperties: { ...data, [field]: otherThan(data[field]) } } as unknown as Partial<Shape>;
}

beforeAll(() => {
  for (const definition of [activityActionShape, activitySwimlaneShape, erdEntityShape]) {
    if (!shapeRegistry.hasHandler(definition.type)) {
      shapeRegistry.register(definition.type, createLibraryShapeHandler(definition), definition.metadata);
    }
  }
});

beforeEach(() => {
  useDocumentStore.getState().clear();
  act(() => useSessionStore.getState().clearSelection());
});

afterEach(cleanup);

/** A profile's properties for this shape, named as the panel names them. */
function namesFor(profile: StyleProfile, shape: Shape): string[] {
  const updates = getProfileUpdates(profile, shape) as Record<string, unknown>;
  return Object.keys(updates).flatMap((key) => {
    if (key !== 'customProperties') return [key];
    const custom = updates[key] as Record<string, unknown>;
    return Object.keys(profile.properties)
      .filter((field) => field in custom)
      .map((field) => `customProperties.${field}`);
  });
}

function styledFixture(title: string) {
  const { shape, properties } = FIXTURES[title]!;
  const profile = profileWith(properties ?? BASE);
  useStyleProfileStore.setState({ profiles: [profile] });
  const base = { id: 's', ...SIZE, opacity: 1, fill: '#111111', stroke: '#222222', strokeWidth: 1, ...shape } as unknown as Shape;
  const styled = { ...base, ...getProfileUpdates(profile, base), styleProfileId: profile.id } as Shape;
  return { profile, styled };
}

function show(shape: Shape) {
  useDocumentStore.getState().addShape(shape);
  act(() => useSessionStore.getState().select([shape.id]));
  return render(<PropertyPanel />);
}

const marks = (container: Element) => Array.from(container.querySelectorAll('.profile-prop--departed'));
const resets = (container: Element) =>
  Array.from(container.querySelectorAll('.profile-prop-reset')).map((button) => button.getAttribute('aria-label'));
const rowCount = () => document.querySelector('.style-row-reset-count')?.textContent ?? null;

describe('every property a profile sets has a row to mark', () => {
  // What a profile writes but the panel has no row for. These stay out of the count.
  const NO_ROW: Record<string, string[]> = {
    // Groups draw their background colour and border, not these.
    group: ['fill', 'stroke', 'strokeWidth'],
    // Lines have no arrow controls, and text has no font control yet.
    line: ['startArrow', 'endArrow'],
    text: ['fontFamily'],
    // The single-icon fields, which a shape with an icon list doesn't use.
    'rectangle with icons': ['iconId', 'iconSize', 'iconPadding', 'iconColor', 'iconPosition', 'iconDisplayMode', 'iconBadge'],
    'library shape with icons': ['iconId', 'iconSize', 'iconPadding', 'iconColor', 'iconPosition', 'iconDisplayMode', 'iconBadge'],
  };

  it('knows every property a profile can set', () => {
    // A new one fails here: add it to WITH_ICONS, then give it a `ProfileProp` row.
    const known = Object.keys(WITH_ICONS);
    expect(STYLE_FACETS.flatMap((facet) => facet.keys).filter((key) => !known.includes(key))).toEqual([]);
  });

  for (const title of Object.keys(FIXTURES)) {
    it(`on a ${title}`, () => {
      const { profile, styled } = styledFixture(title);
      const names = namesFor(profile, styled);
      expect(names.length).toBeGreaterThan(3);
      const results: Record<string, string> = {};
      for (const name of names) {
        useDocumentStore.getState().clear();
        act(() => useSessionStore.getState().clearSelection());
        const view = show({ ...styled, ...departing(styled, name) } as Shape);
        expect(profileDepartures(profile, useDocumentStore.getState().shapes['s']!), name).toEqual([name]);
        const found = marks(view.container).length;
        results[name] = `${found} mark, count ${rowCount()}`;
        view.unmount();
      }
      const expected = Object.fromEntries(
        names.map((name) => [name, NO_ROW[title]?.includes(name) ? '0 mark, count null' : '1 mark, count 1']),
      );
      expect(results).toEqual(expected);
    });
  }

  for (const title of ['rectangle with icons', 'library shape with icons']) {
    it(`marks an emptied icon list on the row that replaces it, on a ${title}`, () => {
      const { styled } = styledFixture(title);
      const view = show({ ...styled, icons: [] } as Shape);
      expect(resets(view.container)).toEqual(['Reset icons to Probe']);
    });
  }

  it('marks a background colour only while there is a background to see', () => {
    const { styled } = styledFixture('group');
    const view = show({ ...styled, backgroundColor: '#000001', showBackground: false } as Shape);
    expect(marks(view.container)).toHaveLength(0);
    expect(rowCount()).toBeNull();
    act(() => useDocumentStore.getState().updateShape('s', { showBackground: true } as Partial<Shape>));
    expect(resets(view.container)).toEqual(['Reset background color to Probe']);
    expect(rowCount()).toBe('1');
  });
});

describe('a marked row', () => {
  const shape = () => useDocumentStore.getState().shapes['s']!;

  it('says nothing while the shape looks like its profile', () => {
    const { styled } = styledFixture('rectangle');
    const view = show(styled);
    expect(marks(view.container)).toHaveLength(0);
    expect(resets(view.container)).toEqual([]);
  });

  it('marks only the rows that differ', () => {
    const { styled } = styledFixture('rectangle');
    const view = show({ ...styled, fill: '#000001', strokeWidth: 99 } as Shape);
    expect(resets(view.container).sort()).toEqual(['Reset fill to Probe', 'Reset stroke width to Probe']);
  });

  it('marks nothing for a shape that only looks like a profile and differs in nothing', () => {
    const { styled } = styledFixture('rectangle');
    const { styleProfileId: _link, ...unlinked } = styled;
    const view = show(unlinked as Shape);
    expect(marks(view.container)).toHaveLength(0);
  });

  it('marks nothing once a link no longer leads to a profile', () => {
    const { styled } = styledFixture('rectangle');
    useStyleProfileStore.setState({ profiles: [] });
    const view = show({ ...styled, fill: '#000001' } as Shape);
    expect(marks(view.container)).toHaveLength(0);
  });

  it('resets its property and nothing else, and stays linked', () => {
    const { styled } = styledFixture('rectangle');
    const view = show({ ...styled, fill: '#000001', strokeWidth: 99 } as Shape);
    fireEvent.click(screen.getByRole('button', { name: 'Reset fill to Probe' }));
    expect(shape().fill).toBe('#101010');
    expect(shape().strokeWidth).toBe(99);
    expect(shape().styleProfileId).toBe('probe');
    expect(resets(view.container)).toEqual(['Reset stroke width to Probe']);
    expect(rowCount()).toBe('1');
  });

  it('resets one field of custom data, and keeps the rest of it', () => {
    const { styled } = styledFixture('swimlane');
    const data = (styled as unknown as { customProperties: object }).customProperties;
    const view = show({
      ...styled,
      customProperties: { ...data, headerBackground: '#000001', separatorWidth: 9 },
    } as unknown as Shape);
    fireEvent.click(screen.getByRole('button', { name: 'Reset header background to Probe' }));
    expect((shape() as unknown as { customProperties: object }).customProperties).toEqual({
      ...data,
      separatorWidth: 9,
    });
    expect(resets(view.container)).toEqual(['Reset separator width to Probe']);
  });

  it('resets every shape selected', () => {
    const { styled } = styledFixture('rectangle');
    useDocumentStore.getState().addShape({ ...styled, id: 's2', fill: '#000002' } as Shape);
    useDocumentStore.getState().addShape({ ...styled, id: 's3', fill: '#000003', strokeWidth: 99 } as Shape);
    act(() => useSessionStore.getState().select(['s2', 's3']));
    render(<PropertyPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset fill to Probe' }));
    const { shapes } = useDocumentStore.getState();
    expect(shapes['s2']!.fill).toBe('#101010');
    expect(shapes['s3']!.fill).toBe('#101010');
    expect(shapes['s3']!.strokeWidth).toBe(99);
  });

  it('is one undo step', () => {
    const page = usePageStore.getState().createPage('Page');
    usePageStore.getState().setActivePage(page);
    useHistoryStore.getState().setActivePage(page);
    const { styled } = styledFixture('rectangle');
    show({ ...styled, fill: '#000001' } as Shape);
    fireEvent.click(screen.getByRole('button', { name: 'Reset fill to Probe' }));
    act(() => useHistoryStore.getState().undo());
    expect(shape().fill).toBe('#000001');
    expect(screen.queryByRole('button', { name: 'Reset fill to Probe' })).not.toBeNull();
  });

  it('stays on the row after a reset from the keyboard', () => {
    const { styled } = styledFixture('rectangle');
    const view = show({ ...styled, strokeWidth: 99 } as Shape);
    const row = view.container.querySelector('.profile-prop--departed')!;
    fireEvent.click(screen.getByRole('button', { name: 'Reset stroke width to Probe' }), { detail: 0 });
    expect(row.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.tagName).toBe('INPUT');
  });

  it('leaves focus alone after a reset with the pointer, so no keyboard rises on a phone', () => {
    const { styled } = styledFixture('rectangle');
    show({ ...styled, strokeWidth: 99 } as Shape);
    fireEvent.click(screen.getByRole('button', { name: 'Reset stroke width to Probe' }), { detail: 1 });
    expect(document.activeElement).toBe(document.body);
  });

  it('is still there in a collapsed section, so its header can say so', () => {
    const { styled } = styledFixture('rectangle');
    const view = show({ ...styled, fill: '#000001' } as Shape);
    const section = view.container.querySelector('.profile-prop--departed')!.closest('.property-section-container')!;
    fireEvent.click(section.querySelector('.property-section-header')!);
    expect(section.classList.contains('collapsed')).toBe(true);
    expect(section.querySelector('.profile-prop--departed')).not.toBeNull();
    fireEvent.click(section.querySelector('.property-section-header')!);
  });

  it('takes its count with it when the selection moves on', () => {
    const { styled } = styledFixture('rectangle');
    const view = show({ ...styled, fill: '#000001' } as Shape);
    expect(rowCount()).toBe('1');
    useDocumentStore.getState().addShape({ ...styled, id: 'same' } as Shape);
    act(() => useSessionStore.getState().select(['same']));
    expect(marks(view.container)).toHaveLength(0);
    expect(rowCount()).toBeNull();
  });
});
