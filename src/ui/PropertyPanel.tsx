import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useSessionStore } from '../store/sessionStore';
import { useDocumentStore } from '../store/documentStore';
import { useUIPreferencesStore } from '../store/uiPreferencesStore';
import {
  Shape,
  isRectangle,
  isEllipse,
  isLine,
  isText,
  isGroup,
  isConnector,
  isLibraryShape,
  GroupShape,
  LibraryShape,
  TextAlign,
  VerticalAlign,
  RoutingMode,
  IconPosition,
  IconDisplayMode,
  IconBadgeShape,
  IconConfig,
  DEFAULT_BADGE_CONFIG,
  ERDCardinality,
  ConnectorType,
  LineStyle,
  UMLClassMarker,
} from '../shapes/Shape';
import type { ERDEntityMember, ERDEntityCustomProps } from '../shapes/library/erdShapes';
import type { UMLClassMember } from '../shapes/library/umlClassShapes';
import { PropertySection } from './PropertySection';
import { CompactColorInput } from './CompactColorInput';
import { AlignmentPanel } from './AlignmentPanel';
import { StyleProfilePanel } from './StyleProfilePanel';
import { IconPicker } from './IconPicker';
import { NumberInput } from './NumberInput';
import { PatternPicker } from './PatternPicker';
import { ShadowEditor } from './ShadowEditor';
import { BorderStylePicker } from './BorderStylePicker';
import { LabelPositionPicker } from './LabelPositionPicker';
import { IconListEditor } from './IconListEditor';
import { shapeRegistry } from '../shapes/ShapeRegistry';
// GroupStyles types are used via the PatternPicker, ShadowEditor, LabelPositionPicker components
import type { ShapeMetadata, PropertyDefinition, PropertySection as PropertySectionType } from '../shapes/ShapeMetadata';
import './PropertyPanel.css';

/** Sentinel value indicating mixed values across selected shapes */
const MIXED = Symbol('mixed');

/**
 * Get the value of a property across multiple shapes.
 * Returns MIXED symbol if values differ, or the common value if all the same.
 */
function getSharedValue<T>(shapes: Shape[], getter: (s: Shape) => T): T | typeof MIXED {
  if (shapes.length === 0) return MIXED;
  const first = getter(shapes[0]!);
  for (let i = 1; i < shapes.length; i++) {
    if (getter(shapes[i]!) !== first) return MIXED;
  }
  return first;
}

/** Constraints for panel width */
const MIN_WIDTH = 180;
const MAX_WIDTH = 400;

/**
 * Compact number input component - wrapper around NumberInput for consistency.
 */
function CompactNumberInput({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}) {
  return (
    <NumberInput
      label={label}
      value={value}
      onChange={onChange}
      step={step}
      {...(min !== undefined && { min })}
      {...(max !== undefined && { max })}
      {...(suffix !== undefined && { suffix })}
    />
  );
}

/**
 * Compact slider input component.
 */
function CompactSliderInput({
  label,
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.05,
  formatValue,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  formatValue?: (value: number) => string;
}) {
  const displayValue = formatValue ? formatValue(value) : value.toString();

  return (
    <div className="compact-slider-row">
      <label className="compact-slider-label">{label}</label>
      <input
        type="range"
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="compact-slider"
        min={min}
        max={max}
        step={step}
      />
      <span className="compact-slider-value">{displayValue}</span>
    </div>
  );
}

/**
 * Info row for read-only values.
 */
function InfoRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="info-row">
      <span className="info-label">{label}</span>
      <span className="info-value">{value}</span>
    </div>
  );
}

/**
 * Generic property editor based on PropertyDefinition.
 */
function MetadataPropertyEditor({
  definition,
  value,
  onChange,
}: {
  definition: PropertyDefinition;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  switch (definition.type) {
    case 'number':
      return (
        <CompactNumberInput
          label={definition.label}
          value={(value as number) ?? (definition.default as number | undefined) ?? 0}
          onChange={(v) => onChange(v)}
          {...(definition.min !== undefined && { min: definition.min })}
          {...(definition.max !== undefined && { max: definition.max })}
          {...(definition.step !== undefined && { step: definition.step })}
        />
      );
    case 'string':
      return (
        <div className="compact-string-row">
          <label className="compact-string-label">{definition.label}</label>
          <input
            type="text"
            value={(value as string) ?? ''}
            onChange={(e) => onChange(e.target.value)}
            className="property-text-input"
            placeholder={definition.placeholder}
          />
        </div>
      );
    case 'color':
      return (
        <CompactColorInput
          label={definition.label}
          value={(value as string) ?? ''}
          onChange={(c) => onChange(c)}
        />
      );
    case 'boolean':
      return (
        <div className="compact-checkbox-row">
          <label className="compact-checkbox-label">{definition.label}</label>
          <input
            type="checkbox"
            checked={(value as boolean) ?? false}
            onChange={(e) => onChange(e.target.checked)}
            className="compact-checkbox"
          />
        </div>
      );
    case 'slider':
      return (
        <CompactSliderInput
          label={definition.label}
          value={(value as number) ?? (definition.default as number | undefined) ?? 0}
          onChange={(v) => onChange(v)}
          {...(definition.min !== undefined && { min: definition.min })}
          {...(definition.max !== undefined && { max: definition.max })}
          {...(definition.step !== undefined && { step: definition.step })}
          formatValue={(v) => definition.max === 1 ? `${Math.round(v * 100)}%` : v.toString()}
        />
      );
    case 'select':
      return (
        <div className="compact-select-row">
          <label className="compact-select-label">{definition.label}</label>
          <select
            value={(value as string) ?? ''}
            onChange={(e) => onChange(e.target.value)}
            className="compact-select"
          >
            {definition.options?.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      );
    default:
      return null;
  }
}

/**
 * Group properties by section for rendering.
 */
function groupBySection(properties: PropertyDefinition[]): Map<PropertySectionType, PropertyDefinition[]> {
  const grouped = new Map<PropertySectionType, PropertyDefinition[]>();
  for (const prop of properties) {
    const section = prop.section;
    if (!grouped.has(section)) {
      grouped.set(section, []);
    }
    grouped.get(section)!.push(prop);
  }
  return grouped;
}

/**
 * Section labels for display.
 */
const SECTION_LABELS: Record<PropertySectionType, string> = {
  appearance: 'Appearance',
  dimensions: 'Dimensions',
  label: 'Label',
  icon: 'Icon',
  endpoints: 'Endpoints',
  routing: 'Routing',
  custom: 'Properties',
};

/**
 * Get a property value from a shape by key.
 */
function getShapeProperty(shape: Shape, key: string): unknown {
  return (shape as unknown as Record<string, unknown>)[key];
}

/**
 * Metadata-driven properties for library shapes.
 */
function LibraryShapeProperties({
  shape,
  metadata,
  selectedShapes,
  updateShape,
}: {
  shape: LibraryShape;
  metadata: ShapeMetadata;
  selectedShapes: Shape[];
  updateShape: (id: string, updates: Partial<Shape>) => void;
}) {
  const groupedProperties = useMemo(() => groupBySection(metadata.properties), [metadata.properties]);

  const handleUpdate = useCallback((key: string, value: unknown) => {
    selectedShapes.forEach((s) => {
      if (isLibraryShape(s)) {
        updateShape(s.id, { [key]: value } as Partial<Shape>);
      }
    });
  }, [selectedShapes, updateShape]);

  return (
    <>
      {/* Appearance Section */}
      {groupedProperties.has('appearance') && (
        <PropertySection id="appearance" title={SECTION_LABELS.appearance} defaultExpanded>
          {groupedProperties.get('appearance')!.map((prop) => (
            <MetadataPropertyEditor
              key={prop.key}
              definition={prop}
              value={getShapeProperty(shape, prop.key)}
              onChange={(v) => handleUpdate(prop.key, v)}
            />
          ))}
        </PropertySection>
      )}

      {/* Label Section */}
      {metadata.supportsLabel && (
        <PropertySection id="label" title={SECTION_LABELS.label} defaultExpanded>
          <input
            type="text"
            value={shape.label || ''}
            onChange={(e) => handleUpdate('label', e.target.value)}
            className="property-text-input"
            placeholder="Enter label..."
          />
          <CompactNumberInput
            label="Font Size"
            value={shape.labelFontSize || 14}
            onChange={(val) => handleUpdate('labelFontSize', val)}
            min={8}
            max={100}
          />
          <CompactColorInput
            label="Color"
            value={shape.labelColor || '#000000'}
            onChange={(color) => handleUpdate('labelColor', color)}
          />
          <CompactColorInput
            label="Background"
            value={shape.labelBackground || ''}
            onChange={(color) => handleUpdate('labelBackground', color)}
            showNoFill
          />
          {/* Label offset controls */}
          {shape.label && (
            <div className="label-offset-row">
              <CompactNumberInput
                label="Offset X"
                value={shape.labelOffsetX || 0}
                onChange={(val) => handleUpdate('labelOffsetX', val)}
                min={-500}
                max={500}
              />
              <CompactNumberInput
                label="Offset Y"
                value={shape.labelOffsetY || 0}
                onChange={(val) => handleUpdate('labelOffsetY', val)}
                min={-500}
                max={500}
              />
              {(shape.labelOffsetX || shape.labelOffsetY) && (
                <button
                  className="label-offset-reset"
                  onClick={() => {
                    handleUpdate('labelOffsetX', 0);
                    handleUpdate('labelOffsetY', 0);
                  }}
                  title="Reset label position"
                >
                  Reset
                </button>
              )}
            </div>
          )}
        </PropertySection>
      )}

      {/* Icon Section */}
      {metadata.supportsIcon && (
        <PropertySection id="icon" title="Icons" defaultExpanded={false}>
          {/* Multi-icon mode: shape has icons array */}
          {(shape.icons && shape.icons.length > 0) ? (
            <IconListEditor
              icons={shape.icons}
              defaultColor={shape.stroke || '#333333'}
              onChange={(icons) => handleUpdate('icons', icons)}
            />
          ) : (
            /* Legacy single-icon mode or no icons */
            <>
              <IconPicker
                value={shape.iconId}
                onChange={(iconId: string | undefined) => handleUpdate('iconId', iconId || '')}
              />
              {shape.iconId && (
                <>
                  {/* Migrate to multi-icon button */}
                  <button
                    className="migrate-to-multi-icon"
                    onClick={() => {
                      // Convert legacy icon to icons array
                      const legacyIcon: IconConfig = {
                        iconId: shape.iconId!,
                        position: shape.iconPosition || 'top-left',
                      };
                      if (shape.iconSize) legacyIcon.size = shape.iconSize;
                      if (shape.iconPadding) legacyIcon.padding = shape.iconPadding;
                      if (shape.iconColor) legacyIcon.color = shape.iconColor;
                      if (shape.iconDisplayMode) legacyIcon.displayMode = shape.iconDisplayMode;
                      if (shape.iconBadge) legacyIcon.badge = shape.iconBadge;

                      handleUpdate('icons', [legacyIcon]);
                      handleUpdate('iconId', '');
                    }}
                    title="Convert to multi-icon mode to add more icons"
                  >
                    + Add More Icons
                  </button>

                  {/* Display Mode */}
                  <div className="compact-select-row">
                    <label className="compact-select-label">Mode</label>
                    <select
                      value={shape.iconDisplayMode || 'inside'}
                      onChange={(e) => handleUpdate('iconDisplayMode', e.target.value as IconDisplayMode)}
                      className="compact-select"
                    >
                      <option value="inside">Inside</option>
                      <option value="badge">Badge</option>
                      <option value="icon-only">Icon Only</option>
                    </select>
                  </div>

                  <CompactNumberInput
                    label="Size"
                    value={shape.iconSize || 24}
                    onChange={(val) => handleUpdate('iconSize', val)}
                    min={12}
                    max={64}
                  />

                  {/* Hide padding/position for icon-only mode */}
                  {shape.iconDisplayMode !== 'icon-only' && (
                    <>
                      <CompactNumberInput
                        label="Padding"
                        value={shape.iconPadding || 8}
                        onChange={(val) => handleUpdate('iconPadding', val)}
                        min={0}
                        max={32}
                      />
                      <div className="compact-select-row">
                        <label className="compact-select-label">Position</label>
                        <select
                          value={shape.iconPosition || 'top-left'}
                          onChange={(e) => handleUpdate('iconPosition', e.target.value as IconPosition)}
                          className="compact-select"
                        >
                          <optgroup label="Corners">
                            <option value="top-left">Top Left</option>
                            <option value="top-right">Top Right</option>
                            <option value="bottom-left">Bottom Left</option>
                            <option value="bottom-right">Bottom Right</option>
                          </optgroup>
                          <optgroup label="Edges">
                            <option value="top">Top Center</option>
                            <option value="bottom">Bottom Center</option>
                            <option value="left">Left Center</option>
                            <option value="right">Right Center</option>
                          </optgroup>
                          <optgroup label="Other">
                            <option value="center">Center</option>
                          </optgroup>
                          <optgroup label="Outside">
                            <option value="top-left-outer">Top Left (Outside)</option>
                            <option value="top-right-outer">Top Right (Outside)</option>
                            <option value="bottom-left-outer">Bottom Left (Outside)</option>
                            <option value="bottom-right-outer">Bottom Right (Outside)</option>
                          </optgroup>
                        </select>
                      </div>
                    </>
                  )}

                  <div className="icon-color-row">
                    <CompactColorInput
                      label="Color"
                      value={shape.iconColor || shape.stroke || '#333333'}
                      onChange={(color) => handleUpdate('iconColor', color)}
                    />
                    {shape.iconColor && (
                      <button
                        className="icon-color-reset"
                        onClick={() => handleUpdate('iconColor', '')}
                        title="Reset to stroke color"
                      >
                        Reset
                      </button>
                    )}
                  </div>

                  {/* Badge Options */}
                  {shape.iconDisplayMode === 'badge' && (
                    <div className="badge-options">
                      <div className="badge-options-header">Badge Options</div>
                      <div className="compact-select-row">
                        <label className="compact-select-label">Shape</label>
                        <select
                          value={shape.iconBadge?.shape || 'circle'}
                          onChange={(e) => {
                            const currentBadge = shape.iconBadge || { ...DEFAULT_BADGE_CONFIG };
                            handleUpdate('iconBadge', { ...currentBadge, shape: e.target.value as IconBadgeShape });
                          }}
                          className="compact-select"
                        >
                          <option value="circle">Circle</option>
                          <option value="rounded-rect">Rounded</option>
                          <option value="square">Square</option>
                        </select>
                      </div>
                      <CompactColorInput
                        label="Background"
                        value={shape.iconBadge?.backgroundColor || '#ffffff'}
                        onChange={(color) => {
                          const currentBadge = shape.iconBadge || { ...DEFAULT_BADGE_CONFIG };
                          handleUpdate('iconBadge', { ...currentBadge, backgroundColor: color });
                        }}
                      />
                      <CompactColorInput
                        label="Border"
                        value={shape.iconBadge?.borderColor || ''}
                        onChange={(color) => {
                          const currentBadge = shape.iconBadge || { ...DEFAULT_BADGE_CONFIG };
                          const updatedBadge = {
                            ...currentBadge,
                            borderWidth: color ? (currentBadge.borderWidth || 1) : 0,
                          };
                          if (color) {
                            updatedBadge.borderColor = color;
                          } else {
                            delete updatedBadge.borderColor;
                          }
                          handleUpdate('iconBadge', updatedBadge);
                        }}
                      />
                      {shape.iconBadge?.borderColor && (
                        <CompactNumberInput
                          label="Border Width"
                          value={shape.iconBadge?.borderWidth || 1}
                          onChange={(val) => {
                            const currentBadge = shape.iconBadge || { ...DEFAULT_BADGE_CONFIG };
                            handleUpdate('iconBadge', { ...currentBadge, borderWidth: val });
                          }}
                          min={0}
                          max={4}
                          suffix="px"
                        />
                      )}
                      <div className="compact-checkbox-row">
                        <label className="compact-checkbox-label">
                          <input
                            type="checkbox"
                            checked={shape.iconBadge?.shadow || false}
                            onChange={(e) => {
                              const currentBadge = shape.iconBadge || { ...DEFAULT_BADGE_CONFIG };
                              handleUpdate('iconBadge', { ...currentBadge, shadow: e.target.checked });
                            }}
                          />
                          Shadow
                        </label>
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </PropertySection>
      )}

      {/* Dimensions Section */}
      {groupedProperties.has('dimensions') && (
        <PropertySection id="dimensions" title={SECTION_LABELS.dimensions} defaultExpanded={false}>
          {groupedProperties.get('dimensions')!.map((prop) => (
            <MetadataPropertyEditor
              key={prop.key}
              definition={prop}
              value={getShapeProperty(shape, prop.key)}
              onChange={(v) => handleUpdate(prop.key, v)}
            />
          ))}
        </PropertySection>
      )}

      {/* Custom Section */}
      {groupedProperties.has('custom') && (
        <PropertySection id="custom" title={SECTION_LABELS.custom} defaultExpanded>
          {groupedProperties.get('custom')!.map((prop) => (
            <MetadataPropertyEditor
              key={prop.key}
              definition={prop}
              value={getShapeProperty(shape, prop.key)}
              onChange={(v) => handleUpdate(prop.key, v)}
            />
          ))}
        </PropertySection>
      )}
    </>
  );
}

/**
 * ERD Entity properties editor for title, members, and table styling.
 */
function ERDEntityProperties({
  shape,
  updateShape,
}: {
  shape: LibraryShape;
  updateShape: (id: string, updates: Partial<Shape>) => void;
}) {
  // Get custom properties with table styling
  const customProps = (shape.customProperties || {}) as ERDEntityCustomProps;

  const entityTitle = customProps.entityTitle || '';
  const members = customProps.members || [];
  const rowSeparatorEnabled = customProps.rowSeparatorEnabled ?? true;
  const rowSeparatorColor = customProps.rowSeparatorColor || '';
  const rowBackgroundColor = customProps.rowBackgroundColor || '';
  const rowAlternateColor = customProps.rowAlternateColor || '';
  const attributePaddingHorizontal = customProps.attributePaddingHorizontal ?? 8;
  const attributePaddingVertical = customProps.attributePaddingVertical ?? 2;

  const updateCustomProps = useCallback((updates: Partial<ERDEntityCustomProps>) => {
    updateShape(shape.id, {
      customProperties: {
        ...customProps,
        ...updates,
      },
    } as Partial<Shape>);
  }, [shape.id, customProps, updateShape]);

  const handleTitleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    updateCustomProps({ entityTitle: e.target.value });
  }, [updateCustomProps]);

  const handleAddMember = useCallback(() => {
    const newMember: ERDEntityMember = { name: '', type: '', isPrimaryKey: false };
    updateCustomProps({ members: [...members, newMember] });
  }, [members, updateCustomProps]);

  const handleRemoveMember = useCallback((index: number) => {
    const newMembers = members.filter((_, i) => i !== index);
    updateCustomProps({ members: newMembers });
  }, [members, updateCustomProps]);

  const handleUpdateMember = useCallback((index: number, updates: Partial<ERDEntityMember>) => {
    const newMembers = members.map((m, i) => (i === index ? { ...m, ...updates } : m));
    updateCustomProps({ members: newMembers });
  }, [members, updateCustomProps]);

  const handleMoveMember = useCallback((fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex || fromIndex < 0 || fromIndex >= members.length) return;
    const newMembers = [...members];
    const [moved] = newMembers.splice(fromIndex, 1);
    if (moved) {
      newMembers.splice(toIndex, 0, moved);
      updateCustomProps({ members: newMembers });
    }
  }, [members, updateCustomProps]);

  // Drag state for reordering
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  return (
    <>
      <PropertySection id="erd-entity" title="Entity" defaultExpanded>
        <div className="compact-string-row">
          <label className="compact-string-label">Name</label>
          <input
            type="text"
            value={entityTitle}
            onChange={handleTitleChange}
            className="property-text-input"
            placeholder="Entity name..."
          />
        </div>
      </PropertySection>

      <PropertySection id="erd-members" title="Attributes" defaultExpanded>
        <div className="erd-members-list">
          {members.map((member, index) => (
            <div
              key={index}
              className={`erd-member-row${dragIndex === index ? ' dragging' : ''}${dragOverIndex === index ? ' drag-over' : ''}`}
              draggable
              onDragStart={(e) => {
                setDragIndex(index);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragEnd={() => {
                if (dragIndex !== null && dragOverIndex !== null) {
                  handleMoveMember(dragIndex, dragOverIndex);
                }
                setDragIndex(null);
                setDragOverIndex(null);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setDragOverIndex(index);
              }}
              onDragLeave={() => {
                setDragOverIndex(null);
              }}
            >
              <span className="member-drag-handle" title="Drag to reorder">⋮⋮</span>
              <button
                type="button"
                className={`toggle-icon-btn erd-member-pk ${member.isPrimaryKey ? 'active' : ''}`}
                onClick={() => handleUpdateMember(index, { isPrimaryKey: !member.isPrimaryKey })}
                title={member.isPrimaryKey ? 'Remove Primary Key' : 'Set as Primary Key'}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
                </svg>
              </button>
              <input
                type="text"
                value={member.name}
                onChange={(e) => handleUpdateMember(index, { name: e.target.value })}
                className="erd-member-name"
                placeholder="name"
              />
              <input
                type="text"
                value={member.type}
                onChange={(e) => handleUpdateMember(index, { type: e.target.value })}
                className="erd-member-type"
                placeholder="type"
              />
              <button
                className="erd-member-remove"
                onClick={() => handleRemoveMember(index)}
                title="Remove attribute"
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <button className="erd-add-member" onClick={handleAddMember}>
          + Add Attribute
        </button>
        <div className="property-hint">
          Click key icon to mark as primary key (underlined). Drag to reorder.
        </div>
      </PropertySection>

      <PropertySection id="erd-table-style" title="Table Style" defaultExpanded={false}>
        <div className="compact-checkbox-row">
          <label className="compact-checkbox-label">
            <input
              type="checkbox"
              checked={rowSeparatorEnabled}
              onChange={(e) => updateCustomProps({ rowSeparatorEnabled: e.target.checked })}
            />
            Row Separators
          </label>
        </div>
        {rowSeparatorEnabled && (
          <CompactColorInput
            label="Separator Color"
            value={rowSeparatorColor}
            onChange={(color) => updateCustomProps({ rowSeparatorColor: color })}
            showNoFill
          />
        )}
        <CompactColorInput
          label="Row Background"
          value={rowBackgroundColor}
          onChange={(color) => updateCustomProps({ rowBackgroundColor: color })}
          showNoFill
        />
        <CompactColorInput
          label="Alternate Row"
          value={rowAlternateColor}
          onChange={(color) => updateCustomProps({ rowAlternateColor: color })}
          showNoFill
        />
        <div className="compact-number-row">
          <label className="compact-number-label">H Padding</label>
          <input
            type="number"
            value={attributePaddingHorizontal}
            onChange={(e) => updateCustomProps({ attributePaddingHorizontal: Number(e.target.value) })}
            className="styled-number-input"
            min={0}
            max={50}
            step={1}
          />
        </div>
        <div className="compact-number-row">
          <label className="compact-number-label">V Padding</label>
          <input
            type="number"
            value={attributePaddingVertical}
            onChange={(e) => updateCustomProps({ attributePaddingVertical: Number(e.target.value) })}
            className="styled-number-input"
            min={0}
            max={20}
            step={1}
          />
        </div>
      </PropertySection>
    </>
  );
}

/**
 * UML Class properties editor for class name, attributes, and methods.
 */
function UMLClassProperties({
  shape,
  updateShape,
}: {
  shape: LibraryShape;
  updateShape: (id: string, updates: Partial<Shape>) => void;
}) {
  // Get custom properties
  const customProps = (shape.customProperties || {}) as {
    className?: string;
    attributes?: UMLClassMember[];
    methods?: UMLClassMember[];
  };

  const className = customProps.className || '';
  const attributes = customProps.attributes || [];
  const methods = customProps.methods || [];

  const updateCustomProps = useCallback((updates: Partial<typeof customProps>) => {
    updateShape(shape.id, {
      customProperties: {
        ...customProps,
        ...updates,
      },
    } as Partial<Shape>);
  }, [shape.id, customProps, updateShape]);

  const handleClassNameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    updateCustomProps({ className: e.target.value });
  }, [updateCustomProps]);

  // Attribute handlers
  const handleAddAttribute = useCallback(() => {
    const newAttr: UMLClassMember = { name: '', type: '', visibility: '-', isStatic: false };
    updateCustomProps({ attributes: [...attributes, newAttr] });
  }, [attributes, updateCustomProps]);

  const handleRemoveAttribute = useCallback((index: number) => {
    const newAttrs = attributes.filter((_, i) => i !== index);
    updateCustomProps({ attributes: newAttrs });
  }, [attributes, updateCustomProps]);

  const handleUpdateAttribute = useCallback((index: number, updates: Partial<UMLClassMember>) => {
    const newAttrs = attributes.map((a, i) => (i === index ? { ...a, ...updates } : a));
    updateCustomProps({ attributes: newAttrs });
  }, [attributes, updateCustomProps]);

  // Method handlers
  const handleAddMethod = useCallback(() => {
    const newMethod: UMLClassMember = { name: '', type: '', visibility: '+', isStatic: false };
    updateCustomProps({ methods: [...methods, newMethod] });
  }, [methods, updateCustomProps]);

  const handleRemoveMethod = useCallback((index: number) => {
    const newMethods = methods.filter((_, i) => i !== index);
    updateCustomProps({ methods: newMethods });
  }, [methods, updateCustomProps]);

  const handleUpdateMethod = useCallback((index: number, updates: Partial<UMLClassMember>) => {
    const newMethods = methods.map((m, i) => (i === index ? { ...m, ...updates } : m));
    updateCustomProps({ methods: newMethods });
  }, [methods, updateCustomProps]);

  // Move handlers for reordering
  const handleMoveAttribute = useCallback((fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex || fromIndex < 0 || fromIndex >= attributes.length) return;
    const newAttrs = [...attributes];
    const [moved] = newAttrs.splice(fromIndex, 1);
    if (moved) {
      newAttrs.splice(toIndex, 0, moved);
      updateCustomProps({ attributes: newAttrs });
    }
  }, [attributes, updateCustomProps]);

  const handleMoveMethod = useCallback((fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex || fromIndex < 0 || fromIndex >= methods.length) return;
    const newMethods = [...methods];
    const [moved] = newMethods.splice(fromIndex, 1);
    if (moved) {
      newMethods.splice(toIndex, 0, moved);
      updateCustomProps({ methods: newMethods });
    }
  }, [methods, updateCustomProps]);

  // Drag state for attributes
  const [attrDragIndex, setAttrDragIndex] = useState<number | null>(null);
  const [attrDragOverIndex, setAttrDragOverIndex] = useState<number | null>(null);

  // Drag state for methods
  const [methodDragIndex, setMethodDragIndex] = useState<number | null>(null);
  const [methodDragOverIndex, setMethodDragOverIndex] = useState<number | null>(null);

  return (
    <>
      <PropertySection id="uml-class" title="Class" defaultExpanded>
        <div className="compact-string-row">
          <label className="compact-string-label">Name</label>
          <input
            type="text"
            value={className}
            onChange={handleClassNameChange}
            className="property-text-input"
            placeholder="ClassName"
          />
        </div>
      </PropertySection>

      <PropertySection id="uml-attributes" title="Attributes" defaultExpanded>
        <div className="uml-members-list">
          {attributes.map((attr, index) => (
            <div
              key={index}
              className={`uml-member-row${attrDragIndex === index ? ' dragging' : ''}${attrDragOverIndex === index ? ' drag-over' : ''}`}
              draggable
              onDragStart={(e) => {
                setAttrDragIndex(index);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragEnd={() => {
                if (attrDragIndex !== null && attrDragOverIndex !== null) {
                  handleMoveAttribute(attrDragIndex, attrDragOverIndex);
                }
                setAttrDragIndex(null);
                setAttrDragOverIndex(null);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setAttrDragOverIndex(index);
              }}
              onDragLeave={() => {
                setAttrDragOverIndex(null);
              }}
            >
              <span className="member-drag-handle" title="Drag to reorder">⋮⋮</span>
              <select
                value={attr.visibility}
                onChange={(e) => handleUpdateAttribute(index, { visibility: e.target.value as UMLClassMember['visibility'] })}
                className="uml-member-visibility"
                title="Visibility"
              >
                <option value="+">+</option>
                <option value="-">-</option>
                <option value="#">#</option>
                <option value="~">~</option>
              </select>
              <input
                type="text"
                value={attr.name}
                onChange={(e) => handleUpdateAttribute(index, { name: e.target.value })}
                className="uml-member-name"
                placeholder="name"
              />
              <input
                type="text"
                value={attr.type}
                onChange={(e) => handleUpdateAttribute(index, { type: e.target.value })}
                className="uml-member-type"
                placeholder="type"
              />
              <button
                type="button"
                className={`uml-member-static ${attr.isStatic ? 'active' : ''}`}
                onClick={() => handleUpdateAttribute(index, { isStatic: !attr.isStatic })}
                title={attr.isStatic ? 'Remove Static' : 'Set as Static (underlined)'}
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="4" y1="20" x2="20" y2="20" />
                  <text x="12" y="14" fontSize="10" textAnchor="middle" fill="currentColor" stroke="none" fontWeight="bold">S</text>
                </svg>
              </button>
              <button
                className="uml-member-remove"
                onClick={() => handleRemoveAttribute(index)}
                title="Remove"
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <button className="uml-add-member" onClick={handleAddAttribute}>
          + Add Attribute
        </button>
      </PropertySection>

      <PropertySection id="uml-methods" title="Methods" defaultExpanded>
        <div className="uml-members-list">
          {methods.map((method, index) => (
            <div
              key={index}
              className={`uml-member-row${methodDragIndex === index ? ' dragging' : ''}${methodDragOverIndex === index ? ' drag-over' : ''}`}
              draggable
              onDragStart={(e) => {
                setMethodDragIndex(index);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragEnd={() => {
                if (methodDragIndex !== null && methodDragOverIndex !== null) {
                  handleMoveMethod(methodDragIndex, methodDragOverIndex);
                }
                setMethodDragIndex(null);
                setMethodDragOverIndex(null);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setMethodDragOverIndex(index);
              }}
              onDragLeave={() => {
                setMethodDragOverIndex(null);
              }}
            >
              <span className="member-drag-handle" title="Drag to reorder">⋮⋮</span>
              <select
                value={method.visibility}
                onChange={(e) => handleUpdateMethod(index, { visibility: e.target.value as UMLClassMember['visibility'] })}
                className="uml-member-visibility"
                title="Visibility"
              >
                <option value="+">+</option>
                <option value="-">-</option>
                <option value="#">#</option>
                <option value="~">~</option>
              </select>
              <input
                type="text"
                value={method.name}
                onChange={(e) => handleUpdateMethod(index, { name: e.target.value })}
                className="uml-member-name"
                placeholder="method()"
              />
              <input
                type="text"
                value={method.type}
                onChange={(e) => handleUpdateMethod(index, { type: e.target.value })}
                className="uml-member-type"
                placeholder="return"
              />
              <button
                type="button"
                className={`uml-member-static ${method.isStatic ? 'active' : ''}`}
                onClick={() => handleUpdateMethod(index, { isStatic: !method.isStatic })}
                title={method.isStatic ? 'Remove Static' : 'Set as Static (underlined)'}
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="4" y1="20" x2="20" y2="20" />
                  <text x="12" y="14" fontSize="10" textAnchor="middle" fill="currentColor" stroke="none" fontWeight="bold">S</text>
                </svg>
              </button>
              <button
                className="uml-member-remove"
                onClick={() => handleRemoveMethod(index)}
                title="Remove"
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <button className="uml-add-member" onClick={handleAddMethod}>
          + Add Method
        </button>
        <div className="property-hint">
          Visibility: + public, - private, # protected, ~ package. Drag to reorder.
        </div>
      </PropertySection>
    </>
  );
}

/**
 * PropertyPanel component for editing selected shape properties.
 *
 * Features:
 * - Collapsible sections with persisted state
 * - Compact color inputs with palette dropdown
 * - Organized property grouping
 * - Multi-selection support
 */
export function PropertyPanel() {
  const selectedIds = useSessionStore((state) => state.selectedIds);
  const shapes = useDocumentStore((state) => state.shapes);
  const updateShape = useDocumentStore((state) => state.updateShape);
  const { propertyPanelWidth, setPropertyPanelWidth } = useUIPreferencesStore();

  // Resize state
  const [width, setWidth] = useState(propertyPanelWidth);
  const [isResizing, setIsResizing] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(propertyPanelWidth);

  // Sync width with store
  useEffect(() => {
    setWidth(propertyPanelWidth);
  }, [propertyPanelWidth]);

  // Handle resize start
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      startXRef.current = e.clientX;
      startWidthRef.current = width;
    },
    [width]
  );

  // Handle resize move and end
  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const delta = startXRef.current - e.clientX;
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidthRef.current + delta));
      setWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      setPropertyPanelWidth(width);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing, width, setPropertyPanelWidth]);

  // Get selected shapes
  const selectedShapes = Array.from(selectedIds)
    .map((id) => shapes[id])
    .filter((s): s is Shape => s !== undefined);

  // Get first selected shape for display
  const shape = selectedShapes[0];
  const isMultiple = selectedShapes.length > 1;
  const isGroupSelected = shape ? isGroup(shape) : false;
  const isLibraryShapeSelected = shape ? isLibraryShape(shape) : false;

  // Get metadata for library shapes
  const shapeMetadata = useMemo(() => {
    if (!shape || !isLibraryShapeSelected) return null;
    return shapeRegistry.getMetadata(shape.type);
  }, [shape, isLibraryShapeSelected]);

  // Calculate group bounds
  const groupBounds = useMemo(() => {
    if (!shape || !isGroupSelected) return null;
    const handler = shapeRegistry.getHandler('group');
    return handler.getBounds(shape as GroupShape);
  }, [isGroupSelected, shape]);

  // Update handlers
  const handleBulkUpdate = useCallback(
    (updates: Partial<Shape>) => {
      selectedShapes.forEach((s) => updateShape(s.id, updates));
    },
    [selectedShapes, updateShape]
  );

  // No selection state
  if (!shape) {
    return (
      <div className="property-panel" style={{ width }}>
        <div
          className={`property-panel-resize-handle ${isResizing ? 'resizing' : ''}`}
          onMouseDown={handleResizeStart}
        />
        <div className="property-panel-header">Properties</div>
        <div className="property-panel-empty">No shape selected</div>
        <StyleProfilePanel />
      </div>
    );
  }

  return (
    <div className="property-panel" style={{ width }}>
      <div
        className={`property-panel-resize-handle ${isResizing ? 'resizing' : ''}`}
        onMouseDown={handleResizeStart}
      />
      <div className="property-panel-header">
        Properties{isMultiple && ` (${selectedShapes.length})`}
      </div>

      {/* Alignment Panel for multi-selection */}
      <AlignmentPanel />

      <div className="property-panel-content">
        {/* Shape Type Badge */}
        <div className="property-type-badge">
          {isGroupSelected ? 'Group' : (shapeMetadata?.name || shape.type)}
          {isGroupSelected && ` (${(shape as GroupShape).childIds.length})`}
        </div>

        {/* Library shape properties - metadata-driven */}
        {isLibraryShapeSelected && shapeMetadata && (
          <LibraryShapeProperties
            shape={shape as LibraryShape}
            metadata={shapeMetadata}
            selectedShapes={selectedShapes}
            updateShape={updateShape}
          />
        )}

        {/* ERD Entity properties - title and members */}
        {isLibraryShapeSelected && (shape.type === 'erd-entity' || shape.type === 'erd-weak-entity') && (
          <ERDEntityProperties
            shape={shape as LibraryShape}
            updateShape={updateShape}
          />
        )}

        {/* UML Class properties - name, attributes, methods */}
        {isLibraryShapeSelected && (
          shape.type === 'uml-class' ||
          shape.type === 'uml-interface' ||
          shape.type === 'uml-abstract-class'
        ) && (
          <UMLClassProperties
            shape={shape as LibraryShape}
            updateShape={updateShape}
          />
        )}

        {/* Group-specific properties */}
        {isGroupSelected && (
          <>
            <PropertySection id="group" title="Group" defaultExpanded>
              <CompactSliderInput
                label="Opacity"
                value={shape.opacity}
                onChange={(val) => handleBulkUpdate({ opacity: val })}
                formatValue={(v) => `${Math.round(v * 100)}%`}
              />
              {groupBounds && (
                <>
                  <InfoRow label="Size" value={`${Math.round(groupBounds.width)} × ${Math.round(groupBounds.height)}`} />
                  <InfoRow label="Position" value={`${Math.round(groupBounds.minX)}, ${Math.round(groupBounds.minY)}`} />
                </>
              )}
              <div className="property-hint">Ctrl+Shift+G to ungroup</div>
            </PropertySection>

            {/* Background Section */}
            <PropertySection id="group-background" title="Background" defaultExpanded={false}>
              <div className="compact-checkbox-row">
                <label>
                  <input
                    type="checkbox"
                    checked={(shape as GroupShape).showBackground || false}
                    onChange={(e) => handleBulkUpdate({ showBackground: e.target.checked })}
                  />
                  <span>Show Background</span>
                </label>
              </div>
              {(shape as GroupShape).showBackground && (
                <>
                  <PatternPicker
                    value={(shape as GroupShape).patternConfig}
                    onChange={(config) => {
                      if (config === undefined) {
                        // Remove pattern config by setting type to 'none'
                        handleBulkUpdate({ patternConfig: { type: 'none' } });
                      } else {
                        handleBulkUpdate({ patternConfig: config });
                      }
                    }}
                  />
                  {/* Only show standalone color when no pattern or solid pattern */}
                  {(!(shape as GroupShape).patternConfig ||
                    (shape as GroupShape).patternConfig?.type === 'none' ||
                    (shape as GroupShape).patternConfig?.type === 'solid') && (
                    <CompactColorInput
                      label="Color"
                      value={(shape as GroupShape).backgroundColor || '#ffffff'}
                      onChange={(color) => handleBulkUpdate({ backgroundColor: color })}
                    />
                  )}
                  <CompactNumberInput
                    label="Padding"
                    value={(shape as GroupShape).backgroundPadding ?? 10}
                    onChange={(val) => handleBulkUpdate({ backgroundPadding: val })}
                    min={0}
                    max={100}
                  />
                  <CompactNumberInput
                    label="Radius"
                    value={(shape as GroupShape).cornerRadius ?? 0}
                    onChange={(val) => handleBulkUpdate({ cornerRadius: val })}
                    min={0}
                    max={50}
                  />
                </>
              )}
            </PropertySection>

            {/* Border Section */}
            <PropertySection id="group-border" title="Border" defaultExpanded={false}>
              <CompactColorInput
                label="Color"
                value={(shape as GroupShape).borderColor || '#000000'}
                onChange={(color) => handleBulkUpdate({ borderColor: color })}
                showNoFill
              />
              <CompactNumberInput
                label="Width"
                value={(shape as GroupShape).borderWidth ?? 0}
                onChange={(val) => handleBulkUpdate({ borderWidth: val })}
                min={0}
                max={20}
              />
              {((shape as GroupShape).borderWidth ?? 0) > 0 && (
                <BorderStylePicker
                  value={(shape as GroupShape).borderDashArray}
                  onChange={(arr) => {
                    if (arr === undefined) {
                      handleBulkUpdate({ borderDashArray: [] });
                    } else {
                      handleBulkUpdate({ borderDashArray: arr });
                    }
                  }}
                />
              )}
            </PropertySection>

            {/* Label Section */}
            <PropertySection id="group-label" title="Label" defaultExpanded={false}>
              <div className="compact-string-row">
                <input
                  type="text"
                  value={(shape as GroupShape).label || ''}
                  onChange={(e) => handleBulkUpdate({ label: e.target.value })}
                  placeholder="Group label..."
                  className="property-text-input"
                />
              </div>
              {(shape as GroupShape).label && (
                <>
                  <CompactNumberInput
                    label="Font Size"
                    value={(shape as GroupShape).labelFontSize ?? 14}
                    onChange={(val) => handleBulkUpdate({ labelFontSize: val })}
                    min={8}
                    max={48}
                  />
                  <CompactColorInput
                    label="Color"
                    value={(shape as GroupShape).labelColor || '#000000'}
                    onChange={(color) => handleBulkUpdate({ labelColor: color })}
                  />
                  <CompactColorInput
                    label="Background"
                    value={(shape as GroupShape).labelBackground || ''}
                    onChange={(color) => handleBulkUpdate({ labelBackground: color })}
                    showNoFill
                  />
                  <LabelPositionPicker
                    value={(shape as GroupShape).labelPosition}
                    onChange={(pos) => handleBulkUpdate({ labelPosition: pos })}
                  />
                  <div className="label-offset-row">
                    <CompactNumberInput
                      label="Offset X"
                      value={(shape as GroupShape).labelOffsetX ?? 0}
                      onChange={(val) => handleBulkUpdate({ labelOffsetX: val })}
                      min={-200}
                      max={200}
                    />
                    <CompactNumberInput
                      label="Y"
                      value={(shape as GroupShape).labelOffsetY ?? 0}
                      onChange={(val) => handleBulkUpdate({ labelOffsetY: val })}
                      min={-200}
                      max={200}
                    />
                    {((shape as GroupShape).labelOffsetX || (shape as GroupShape).labelOffsetY) && (
                      <button
                        className="label-offset-reset"
                        onClick={() => handleBulkUpdate({ labelOffsetX: 0, labelOffsetY: 0 })}
                        title="Reset offset"
                      >
                        Reset
                      </button>
                    )}
                  </div>
                </>
              )}
            </PropertySection>

            {/* Shadow Section */}
            <PropertySection id="group-shadow" title="Shadow" defaultExpanded={false}>
              <ShadowEditor
                value={(shape as GroupShape).shadowConfig}
                onChange={(config) => {
                  if (config === undefined) {
                    handleBulkUpdate({ shadowConfig: { enabled: false, offsetX: 0, offsetY: 0, blur: 0, color: 'transparent' } });
                  } else {
                    handleBulkUpdate({ shadowConfig: config });
                  }
                }}
              />
            </PropertySection>
          </>
        )}

        {/* Appearance Section - only for non-group, non-library shapes */}
        {!isGroupSelected && !isLibraryShapeSelected && (
          <PropertySection id="appearance" title="Appearance" defaultExpanded>
            {/* Fill Color */}
            {shape.fill !== null && (
              <CompactColorInput
                label={isMultiple && getSharedValue(selectedShapes, (s) => s.fill) === MIXED ? 'Fill (Mixed)' : 'Fill'}
                value={shape.fill || ''}
                onChange={(color) => handleBulkUpdate({ fill: color })}
                showNoFill
              />
            )}

            {/* Stroke Color & Width */}
            {shape.stroke !== null && (
              <div className="stroke-row">
                <CompactColorInput
                  label={isMultiple && getSharedValue(selectedShapes, (s) => s.stroke) === MIXED ? 'Stroke (Mixed)' : 'Stroke'}
                  value={shape.stroke || ''}
                  onChange={(color) => handleBulkUpdate({ stroke: color })}
                />
                <CompactNumberInput
                  label="W"
                  value={shape.strokeWidth}
                  onChange={(val) => handleBulkUpdate({ strokeWidth: val })}
                  min={0}
                  max={50}
                />
              </div>
            )}

            {/* Opacity */}
            <CompactSliderInput
              label={isMultiple && getSharedValue(selectedShapes, (s) => s.opacity) === MIXED ? 'Opacity (Mixed)' : 'Opacity'}
              value={shape.opacity}
              onChange={(val) => handleBulkUpdate({ opacity: val })}
              formatValue={(v) => `${Math.round(v * 100)}%`}
            />

            {/* Corner Radius for rectangles */}
            {isRectangle(shape) && (
              <CompactNumberInput
                label="Radius"
                value={shape.cornerRadius}
                onChange={(val) => {
                  selectedShapes.forEach((s) => {
                    if (isRectangle(s)) updateShape(s.id, { cornerRadius: val });
                  });
                }}
                min={0}
                max={100}
              />
            )}
          </PropertySection>
        )}

        {/* Label Section for Rectangle and Ellipse */}
        {(isRectangle(shape) || isEllipse(shape)) && (
          <PropertySection id="label" title="Label" defaultExpanded>
            <input
              type="text"
              value={shape.label || ''}
              onChange={(e) => {
                const val = e.target.value;
                selectedShapes.forEach((s) => {
                  if (isRectangle(s) || isEllipse(s)) {
                    updateShape(s.id, { label: val || '' });
                  }
                });
              }}
              className="property-text-input"
              placeholder="Enter label..."
            />
            <CompactNumberInput
              label="Font Size"
              value={shape.labelFontSize || 14}
              onChange={(val) => {
                selectedShapes.forEach((s) => {
                  if (isRectangle(s) || isEllipse(s)) {
                    updateShape(s.id, { labelFontSize: val });
                  }
                });
              }}
              min={8}
              max={100}
              suffix="px"
            />
            <CompactColorInput
              label="Color"
              value={shape.labelColor || shape.stroke || '#000000'}
              onChange={(color) => {
                selectedShapes.forEach((s) => {
                  if (isRectangle(s) || isEllipse(s)) {
                    updateShape(s.id, { labelColor: color });
                  }
                });
              }}
            />
            <CompactColorInput
              label="Background"
              value={shape.labelBackground || ''}
              onChange={(color) => {
                selectedShapes.forEach((s) => {
                  if (isRectangle(s) || isEllipse(s)) {
                    updateShape(s.id, { labelBackground: color });
                  }
                });
              }}
              showNoFill
            />
            {/* Label offset controls */}
            {shape.label && (
              <div className="label-offset-row">
                <CompactNumberInput
                  label="Offset X"
                  value={shape.labelOffsetX || 0}
                  onChange={(val) => {
                    selectedShapes.forEach((s) => {
                      if (isRectangle(s) || isEllipse(s)) {
                        updateShape(s.id, { labelOffsetX: val });
                      }
                    });
                  }}
                  min={-500}
                  max={500}
                  suffix="px"
                />
                <CompactNumberInput
                  label="Offset Y"
                  value={shape.labelOffsetY || 0}
                  onChange={(val) => {
                    selectedShapes.forEach((s) => {
                      if (isRectangle(s) || isEllipse(s)) {
                        updateShape(s.id, { labelOffsetY: val });
                      }
                    });
                  }}
                  min={-500}
                  max={500}
                  suffix="px"
                />
                {(shape.labelOffsetX || shape.labelOffsetY) && (
                  <button
                    className="label-offset-reset"
                    onClick={() => {
                      selectedShapes.forEach((s) => {
                        if (isRectangle(s) || isEllipse(s)) {
                          updateShape(s.id, { labelOffsetX: 0, labelOffsetY: 0 });
                        }
                      });
                    }}
                    title="Reset label position"
                  >
                    Reset
                  </button>
                )}
              </div>
            )}
          </PropertySection>
        )}

        {/* Icon Section for Rectangle and Ellipse */}
        {(isRectangle(shape) || isEllipse(shape)) && (
          <PropertySection id="icon" title="Icons" defaultExpanded={false}>
            {/* Multi-icon mode: shape has icons array */}
            {(shape.icons && shape.icons.length > 0) ? (
              <IconListEditor
                icons={shape.icons}
                defaultColor={shape.stroke || '#333333'}
                onChange={(icons) => {
                  selectedShapes.forEach((s) => {
                    if (isRectangle(s) || isEllipse(s)) {
                      updateShape(s.id, { icons });
                    }
                  });
                }}
              />
            ) : (
              /* Legacy single-icon mode or no icons */
              <>
                <IconPicker
                  value={shape.iconId}
                  onChange={(iconId: string | undefined) => {
                    selectedShapes.forEach((s) => {
                      if (isRectangle(s) || isEllipse(s)) {
                        updateShape(s.id, { iconId: iconId || '' });
                      }
                    });
                  }}
                />
                {shape.iconId && (
                  <>
                    {/* Migrate to multi-icon button */}
                    <button
                      className="migrate-to-multi-icon"
                      onClick={() => {
                        selectedShapes.forEach((s) => {
                          if ((isRectangle(s) || isEllipse(s)) && s.iconId) {
                            // Convert legacy icon to icons array
                            const legacyIcon: IconConfig = {
                              iconId: s.iconId,
                              position: s.iconPosition || 'top-left',
                            };
                            if (s.iconSize) legacyIcon.size = s.iconSize;
                            if (s.iconPadding) legacyIcon.padding = s.iconPadding;
                            if (s.iconColor) legacyIcon.color = s.iconColor;
                            if (s.iconDisplayMode) legacyIcon.displayMode = s.iconDisplayMode;
                            if (s.iconBadge) legacyIcon.badge = s.iconBadge;

                            updateShape(s.id, {
                              icons: [legacyIcon],
                              // Clear legacy properties
                              iconId: '',
                            });
                          }
                        });
                      }}
                      title="Convert to multi-icon mode to add more icons"
                    >
                      + Add More Icons
                    </button>

                    {/* Display Mode Selector */}
                    <div className="compact-select-row">
                      <label className="compact-select-label">Mode</label>
                      <select
                        value={shape.iconDisplayMode || 'inside'}
                        onChange={(e) => {
                          const val = e.target.value as IconDisplayMode;
                          selectedShapes.forEach((s) => {
                            if (isRectangle(s) || isEllipse(s)) {
                              updateShape(s.id, { iconDisplayMode: val });
                            }
                          });
                        }}
                        className="compact-select"
                      >
                        <option value="inside">Inside</option>
                        <option value="badge">Badge</option>
                        <option value="icon-only">Icon Only</option>
                      </select>
                    </div>

                    <CompactNumberInput
                      label="Size"
                      value={shape.iconSize || 24}
                      onChange={(val) => {
                        selectedShapes.forEach((s) => {
                          if (isRectangle(s) || isEllipse(s)) {
                            updateShape(s.id, { iconSize: val });
                          }
                        });
                      }}
                      min={12}
                      max={64}
                      suffix="px"
                    />

                    {/* Hide padding/position for icon-only mode */}
                    {shape.iconDisplayMode !== 'icon-only' && (
                      <>
                        <CompactNumberInput
                          label="Padding"
                          value={shape.iconPadding || 8}
                          onChange={(val) => {
                            selectedShapes.forEach((s) => {
                              if (isRectangle(s) || isEllipse(s)) {
                                updateShape(s.id, { iconPadding: val });
                              }
                            });
                          }}
                          min={0}
                          max={32}
                          suffix="px"
                        />
                        <div className="compact-select-row">
                          <label className="compact-select-label">Position</label>
                          <select
                            value={shape.iconPosition || 'top-left'}
                            onChange={(e) => {
                              const val = e.target.value as IconPosition;
                              selectedShapes.forEach((s) => {
                                if (isRectangle(s) || isEllipse(s)) {
                                  updateShape(s.id, { iconPosition: val });
                                }
                              });
                            }}
                            className="compact-select"
                          >
                            <optgroup label="Corners">
                              <option value="top-left">Top Left</option>
                              <option value="top-right">Top Right</option>
                              <option value="bottom-left">Bottom Left</option>
                              <option value="bottom-right">Bottom Right</option>
                            </optgroup>
                            <optgroup label="Edges">
                              <option value="top">Top Center</option>
                              <option value="bottom">Bottom Center</option>
                              <option value="left">Left Center</option>
                              <option value="right">Right Center</option>
                            </optgroup>
                            <optgroup label="Other">
                              <option value="center">Center</option>
                            </optgroup>
                            <optgroup label="Outside">
                              <option value="top-left-outer">Top Left (Outside)</option>
                              <option value="top-right-outer">Top Right (Outside)</option>
                              <option value="bottom-left-outer">Bottom Left (Outside)</option>
                              <option value="bottom-right-outer">Bottom Right (Outside)</option>
                            </optgroup>
                          </select>
                        </div>
                      </>
                    )}

                    <div className="icon-color-row">
                      <CompactColorInput
                        label="Color"
                        value={shape.iconColor || shape.stroke || '#333333'}
                        onChange={(color) => {
                          selectedShapes.forEach((s) => {
                            if (isRectangle(s) || isEllipse(s)) {
                              updateShape(s.id, { iconColor: color });
                            }
                          });
                        }}
                      />
                      {shape.iconColor && (
                        <button
                          className="icon-color-reset"
                          onClick={() => {
                            selectedShapes.forEach((s) => {
                              if (isRectangle(s) || isEllipse(s)) {
                                updateShape(s.id, { iconColor: '' });
                              }
                            });
                          }}
                          title="Reset to stroke color"
                        >
                          Reset
                        </button>
                      )}
                    </div>

                    {/* Badge Options (when mode = 'badge') */}
                    {shape.iconDisplayMode === 'badge' && (
                      <div className="badge-options">
                        <div className="badge-options-header">Badge Options</div>
                        <div className="compact-select-row">
                          <label className="compact-select-label">Shape</label>
                          <select
                            value={shape.iconBadge?.shape || 'circle'}
                            onChange={(e) => {
                              const badgeShape = e.target.value as IconBadgeShape;
                              selectedShapes.forEach((s) => {
                                if (isRectangle(s) || isEllipse(s)) {
                                  const currentBadge = s.iconBadge || { ...DEFAULT_BADGE_CONFIG };
                                  updateShape(s.id, {
                                    iconBadge: { ...currentBadge, shape: badgeShape },
                                  });
                                }
                              });
                            }}
                            className="compact-select"
                          >
                            <option value="circle">Circle</option>
                            <option value="rounded-rect">Rounded</option>
                            <option value="square">Square</option>
                          </select>
                        </div>
                        <CompactColorInput
                          label="Background"
                          value={shape.iconBadge?.backgroundColor || '#ffffff'}
                          onChange={(color) => {
                            selectedShapes.forEach((s) => {
                              if (isRectangle(s) || isEllipse(s)) {
                                const currentBadge = s.iconBadge || { ...DEFAULT_BADGE_CONFIG };
                                updateShape(s.id, {
                                  iconBadge: { ...currentBadge, backgroundColor: color },
                                });
                              }
                            });
                          }}
                        />
                        <CompactColorInput
                          label="Border"
                          value={shape.iconBadge?.borderColor || ''}
                          onChange={(color) => {
                            selectedShapes.forEach((s) => {
                              if (isRectangle(s) || isEllipse(s)) {
                                const currentBadge = s.iconBadge || { ...DEFAULT_BADGE_CONFIG };
                                const updatedBadge = {
                                  ...currentBadge,
                                  borderWidth: color ? (currentBadge.borderWidth || 1) : 0,
                                };
                                if (color) {
                                  updatedBadge.borderColor = color;
                                } else {
                                  delete updatedBadge.borderColor;
                                }
                                updateShape(s.id, { iconBadge: updatedBadge });
                              }
                            });
                          }}
                        />
                        {shape.iconBadge?.borderColor && (
                          <CompactNumberInput
                            label="Border Width"
                            value={shape.iconBadge?.borderWidth || 1}
                            onChange={(val) => {
                              selectedShapes.forEach((s) => {
                                if (isRectangle(s) || isEllipse(s)) {
                                  const currentBadge = s.iconBadge || { ...DEFAULT_BADGE_CONFIG };
                                  updateShape(s.id, {
                                    iconBadge: { ...currentBadge, borderWidth: val },
                                  });
                                }
                              });
                            }}
                            min={0}
                            max={4}
                            suffix="px"
                          />
                        )}
                        <div className="compact-checkbox-row">
                          <label className="compact-checkbox-label">
                            <input
                              type="checkbox"
                              checked={shape.iconBadge?.shadow || false}
                              onChange={(e) => {
                                const shadow = e.target.checked;
                                selectedShapes.forEach((s) => {
                                  if (isRectangle(s) || isEllipse(s)) {
                                    const currentBadge = s.iconBadge || { ...DEFAULT_BADGE_CONFIG };
                                    updateShape(s.id, {
                                      iconBadge: { ...currentBadge, shadow },
                                    });
                                  }
                                });
                              }}
                            />
                            Shadow
                          </label>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </PropertySection>
        )}

        {/* Text Shape Properties */}
        {isText(shape) && (
          <PropertySection id="text" title="Text" defaultExpanded>
            <textarea
              value={shape.text}
              onChange={(e) => {
                const val = e.target.value;
                selectedShapes.forEach((s) => {
                  if (isText(s)) updateShape(s.id, { text: val });
                });
              }}
              className="property-textarea"
              rows={3}
            />
            <CompactNumberInput
              label="Font Size"
              value={shape.fontSize}
              onChange={(val) => {
                selectedShapes.forEach((s) => {
                  if (isText(s)) updateShape(s.id, { fontSize: val });
                });
              }}
              min={8}
              max={200}
              suffix="px"
            />
            <div className="align-row">
              <label className="align-label">Align</label>
              <div className="align-buttons">
                {(['left', 'center', 'right'] as TextAlign[]).map((align) => (
                  <button
                    key={align}
                    className={`align-button ${shape.textAlign === align ? 'active' : ''}`}
                    onClick={() => {
                      selectedShapes.forEach((s) => {
                        if (isText(s)) updateShape(s.id, { textAlign: align });
                      });
                    }}
                    title={align}
                  >
                    {align === 'left' ? '\u2190' : align === 'center' ? '\u2194' : '\u2192'}
                  </button>
                ))}
              </div>
              <div className="align-buttons">
                {(['top', 'middle', 'bottom'] as VerticalAlign[]).map((align) => (
                  <button
                    key={align}
                    className={`align-button ${shape.verticalAlign === align ? 'active' : ''}`}
                    onClick={() => {
                      selectedShapes.forEach((s) => {
                        if (isText(s)) updateShape(s.id, { verticalAlign: align });
                      });
                    }}
                    title={align}
                  >
                    {align === 'top' ? '\u2191' : align === 'middle' ? '\u2195' : '\u2193'}
                  </button>
                ))}
              </div>
            </div>
          </PropertySection>
        )}

        {/* Position Section - collapsed by default, for core shapes only */}
        {!isGroupSelected && !isLibraryShapeSelected && (
          <PropertySection id="position" title="Position" defaultExpanded={false}>
            <InfoRow label="X" value={Math.round(shape.x)} />
            <InfoRow label="Y" value={Math.round(shape.y)} />
            <InfoRow label="Rotation" value={`${Math.round((shape.rotation * 180) / Math.PI)}°`} />
          </PropertySection>
        )}

        {/* Size Section - collapsed by default */}
        {(isRectangle(shape) || isEllipse(shape)) && (
          <PropertySection id="size" title="Size" defaultExpanded={false}>
            {isRectangle(shape) && (
              <>
                <InfoRow label="Width" value={Math.round(shape.width)} />
                <InfoRow label="Height" value={Math.round(shape.height)} />
              </>
            )}
            {isEllipse(shape) && (
              <>
                <InfoRow label="Radius X" value={Math.round(shape.radiusX)} />
                <InfoRow label="Radius Y" value={Math.round(shape.radiusY)} />
              </>
            )}
          </PropertySection>
        )}

        {/* Line Endpoints - collapsed by default */}
        {isLine(shape) && (
          <PropertySection id="endpoints" title="Endpoints" defaultExpanded={false}>
            <InfoRow label="Start" value={`(${Math.round(shape.x)}, ${Math.round(shape.y)})`} />
            <InfoRow label="End" value={`(${Math.round(shape.x2)}, ${Math.round(shape.y2)})`} />
          </PropertySection>
        )}

        {/* Connector Routing Section */}
        {isConnector(shape) && (
          <PropertySection id="connector-routing" title="Routing" defaultExpanded>
            <div className="compact-select-row">
              <label className="compact-select-label">Mode</label>
              <select
                value={shape.routingMode || 'straight'}
                onChange={(e) => {
                  const val = e.target.value as RoutingMode;
                  selectedShapes.forEach((s) => {
                    if (isConnector(s)) {
                      // When switching to straight, clear waypoints by setting empty array
                      // When switching to orthogonal, keep existing or set empty
                      updateShape(s.id, {
                        routingMode: val,
                        waypoints: val === 'straight' ? [] : (s.waypoints || []),
                      });
                    }
                  });
                }}
                className="compact-select"
              >
                <option value="straight">Straight</option>
                <option value="orthogonal">Orthogonal</option>
              </select>
            </div>
          </PropertySection>
        )}

        {/* Connector Type Section */}
        {isConnector(shape) && (
          <PropertySection id="connector-type" title="Connector Type" defaultExpanded>
            <div className="compact-select-row">
              <label className="compact-select-label">Type</label>
              <select
                value={shape.connectorType || 'default'}
                onChange={(e) => {
                  const val = e.target.value as ConnectorType;
                  selectedShapes.forEach((s) => {
                    if (isConnector(s)) {
                      // Reset type-specific properties when changing type
                      // Use 'none' as reset value (effectively disables the markers)
                      const updates: Partial<typeof s> = { connectorType: val };
                      if (val !== 'erd') {
                        updates.startCardinality = 'none';
                        updates.endCardinality = 'none';
                      }
                      if (val !== 'uml-class') {
                        updates.startUMLMarker = 'none';
                        updates.endUMLMarker = 'none';
                      }
                      updateShape(s.id, updates);
                    }
                  });
                }}
                className="compact-select"
              >
                <option value="default">Default (Arrows)</option>
                <option value="erd">ERD (Crow's Foot)</option>
                <option value="uml-class">UML Class Diagram</option>
              </select>
            </div>
            <div className="compact-select-row">
              <label className="compact-select-label">Line Style</label>
              <select
                value={shape.lineStyle || 'solid'}
                onChange={(e) => {
                  const val = e.target.value as LineStyle;
                  selectedShapes.forEach((s) => {
                    if (isConnector(s)) {
                      updateShape(s.id, { lineStyle: val });
                    }
                  });
                }}
                className="compact-select"
              >
                <option value="solid">Solid</option>
                <option value="dashed">Dashed</option>
              </select>
            </div>
          </PropertySection>
        )}

        {/* UML Class Diagram Markers Section */}
        {isConnector(shape) && shape.connectorType === 'uml-class' && (
          <PropertySection id="uml-markers" title="UML Markers" defaultExpanded>
            <div className="compact-select-row">
              <label className="compact-select-label">Start</label>
              <select
                value={shape.startUMLMarker || 'none'}
                onChange={(e) => {
                  const val = e.target.value as UMLClassMarker;
                  selectedShapes.forEach((s) => {
                    if (isConnector(s)) {
                      updateShape(s.id, { startUMLMarker: val });
                    }
                  });
                }}
                className="compact-select"
              >
                <option value="none">None</option>
                <option value="arrow">Arrow (navigable)</option>
                <option value="triangle">Triangle (inheritance)</option>
                <option value="triangle-filled">Triangle Filled</option>
                <option value="diamond">Diamond (aggregation)</option>
                <option value="diamond-filled">Diamond Filled (composition)</option>
                <option value="circle">Circle (interface)</option>
                <option value="socket">Socket (required interface)</option>
              </select>
            </div>
            <div className="compact-select-row">
              <label className="compact-select-label">End</label>
              <select
                value={shape.endUMLMarker || 'none'}
                onChange={(e) => {
                  const val = e.target.value as UMLClassMarker;
                  selectedShapes.forEach((s) => {
                    if (isConnector(s)) {
                      updateShape(s.id, { endUMLMarker: val });
                    }
                  });
                }}
                className="compact-select"
              >
                <option value="none">None</option>
                <option value="arrow">Arrow (navigable)</option>
                <option value="triangle">Triangle (inheritance)</option>
                <option value="triangle-filled">Triangle Filled</option>
                <option value="diamond">Diamond (aggregation)</option>
                <option value="diamond-filled">Diamond Filled (composition)</option>
                <option value="circle">Circle (interface)</option>
                <option value="socket">Socket (required interface)</option>
              </select>
            </div>
            <div className="property-hint">
              Quick presets:
            </div>
            <div className="preset-buttons">
              <button
                className="preset-button"
                title="Association (solid line)"
                onClick={() => {
                  selectedShapes.forEach((s) => {
                    if (isConnector(s)) {
                      updateShape(s.id, {
                        lineStyle: 'solid',
                        startUMLMarker: 'none',
                        endUMLMarker: 'none',
                      });
                    }
                  });
                }}
              >—</button>
              <button
                className="preset-button"
                title="Aggregation (hollow diamond)"
                onClick={() => {
                  selectedShapes.forEach((s) => {
                    if (isConnector(s)) {
                      updateShape(s.id, {
                        lineStyle: 'solid',
                        startUMLMarker: 'diamond',
                        endUMLMarker: 'none',
                      });
                    }
                  });
                }}
              >◇—</button>
              <button
                className="preset-button"
                title="Composition (filled diamond)"
                onClick={() => {
                  selectedShapes.forEach((s) => {
                    if (isConnector(s)) {
                      updateShape(s.id, {
                        lineStyle: 'solid',
                        startUMLMarker: 'diamond-filled',
                        endUMLMarker: 'none',
                      });
                    }
                  });
                }}
              >◆—</button>
              <button
                className="preset-button"
                title="Inheritance (hollow triangle)"
                onClick={() => {
                  selectedShapes.forEach((s) => {
                    if (isConnector(s)) {
                      updateShape(s.id, {
                        lineStyle: 'solid',
                        startUMLMarker: 'none',
                        endUMLMarker: 'triangle',
                      });
                    }
                  });
                }}
              >—▷</button>
              <button
                className="preset-button"
                title="Realization (dashed + triangle)"
                onClick={() => {
                  selectedShapes.forEach((s) => {
                    if (isConnector(s)) {
                      updateShape(s.id, {
                        lineStyle: 'dashed',
                        startUMLMarker: 'none',
                        endUMLMarker: 'triangle',
                      });
                    }
                  });
                }}
              >- -▷</button>
              <button
                className="preset-button"
                title="Dependency (dashed + arrow)"
                onClick={() => {
                  selectedShapes.forEach((s) => {
                    if (isConnector(s)) {
                      updateShape(s.id, {
                        lineStyle: 'dashed',
                        startUMLMarker: 'none',
                        endUMLMarker: 'arrow',
                      });
                    }
                  });
                }}
              >- -&gt;</button>
            </div>
          </PropertySection>
        )}

        {/* Connector Cardinality Section (ERD Crow's Foot) - only show when connectorType is 'erd' */}
        {isConnector(shape) && (shape.connectorType === 'erd' || (!shape.connectorType && (shape.startCardinality || shape.endCardinality))) && (
          <PropertySection id="connector-cardinality" title="ERD Cardinality" defaultExpanded>
            <div className="compact-select-row">
              <label className="compact-select-label">Start</label>
              <select
                value={shape.startCardinality || 'none'}
                onChange={(e) => {
                  const val = e.target.value as ERDCardinality;
                  selectedShapes.forEach((s) => {
                    if (isConnector(s)) {
                      updateShape(s.id, { startCardinality: val });
                    }
                  });
                }}
                className="compact-select"
              >
                <option value="none">None (Arrow)</option>
                <option value="one">One (|)</option>
                <option value="many">Many (Crow's Foot)</option>
                <option value="zero-one">Zero or One (o|)</option>
                <option value="zero-many">Zero or Many (o&lt;)</option>
                <option value="one-many">One or Many (|&lt;)</option>
              </select>
            </div>
            <div className="compact-select-row">
              <label className="compact-select-label">End</label>
              <select
                value={shape.endCardinality || 'none'}
                onChange={(e) => {
                  const val = e.target.value as ERDCardinality;
                  selectedShapes.forEach((s) => {
                    if (isConnector(s)) {
                      updateShape(s.id, { endCardinality: val });
                    }
                  });
                }}
                className="compact-select"
              >
                <option value="none">None (Arrow)</option>
                <option value="one">One (|)</option>
                <option value="many">Many (Crow's Foot)</option>
                <option value="zero-one">Zero or One (o|)</option>
                <option value="zero-many">Zero or Many (o&lt;)</option>
                <option value="one-many">One or Many (|&lt;)</option>
              </select>
            </div>
            <div className="property-hint">
              Crow's Foot notation for entity-relationship diagrams
            </div>
          </PropertySection>
        )}

        {/* Connector Label Section */}
        {isConnector(shape) && (
          <PropertySection id="connector-label" title="Label" defaultExpanded>
            <input
              type="text"
              value={shape.label || ''}
              onChange={(e) => {
                const val = e.target.value;
                selectedShapes.forEach((s) => {
                  if (isConnector(s)) {
                    // Use empty string instead of undefined for empty label
                    updateShape(s.id, { label: val });
                  }
                });
              }}
              className="property-text-input"
              placeholder="Enter label..."
            />
            <CompactNumberInput
              label="Font Size"
              value={shape.labelFontSize || 12}
              onChange={(val) => {
                selectedShapes.forEach((s) => {
                  if (isConnector(s)) {
                    updateShape(s.id, { labelFontSize: val });
                  }
                });
              }}
              min={8}
              max={32}
            />
            <CompactColorInput
              label="Color"
              value={shape.labelColor || shape.stroke || '#000000'}
              onChange={(color) => {
                selectedShapes.forEach((s) => {
                  if (isConnector(s)) {
                    updateShape(s.id, { labelColor: color });
                  }
                });
              }}
            />
            <CompactColorInput
              label="Background"
              value={shape.labelBackground || ''}
              onChange={(color) => {
                selectedShapes.forEach((s) => {
                  if (isConnector(s)) {
                    updateShape(s.id, { labelBackground: color });
                  }
                });
              }}
              showNoFill
            />
            {/* Label offset controls */}
            {shape.label && (
              <div className="label-offset-row">
                <CompactNumberInput
                  label="Offset X"
                  value={shape.labelOffsetX || 0}
                  onChange={(val) => {
                    selectedShapes.forEach((s) => {
                      if (isConnector(s)) {
                        updateShape(s.id, { labelOffsetX: val });
                      }
                    });
                  }}
                  min={-500}
                  max={500}
                  suffix="px"
                />
                <CompactNumberInput
                  label="Offset Y"
                  value={shape.labelOffsetY || 0}
                  onChange={(val) => {
                    selectedShapes.forEach((s) => {
                      if (isConnector(s)) {
                        updateShape(s.id, { labelOffsetY: val });
                      }
                    });
                  }}
                  min={-500}
                  max={500}
                  suffix="px"
                />
                {(shape.labelOffsetX || shape.labelOffsetY) && (
                  <button
                    className="label-offset-reset"
                    onClick={() => {
                      selectedShapes.forEach((s) => {
                        if (isConnector(s)) {
                          updateShape(s.id, { labelOffsetX: 0, labelOffsetY: 0 });
                        }
                      });
                    }}
                    title="Reset label position"
                  >
                    Reset
                  </button>
                )}
              </div>
            )}
          </PropertySection>
        )}

        {/* Connector Endpoints Section */}
        {isConnector(shape) && (
          <PropertySection id="connector-endpoints" title="Endpoints" defaultExpanded={false}>
            <InfoRow label="Start" value={`(${Math.round(shape.x)}, ${Math.round(shape.y)})`} />
            <InfoRow label="End" value={`(${Math.round(shape.x2)}, ${Math.round(shape.y2)})`} />
          </PropertySection>
        )}
      </div>

      {/* Style Profiles */}
      <StyleProfilePanel />
    </div>
  );
}
