# Utility Modules Reference

Diagrammer's core utility modules provide math primitives, color manipulation, file handling, and export functionality. All math types are immutable — every operation returns a new instance.

## Math Utilities

Location: `src/math/` — All re-exported from `src/math/index.ts`

### Vec2 <Badge type="info" text="src/math/Vec2.ts" />

2D immutable vector. All methods return new instances.

#### Static Factories

| Method | Returns | Description |
|--------|---------|-------------|
| `Vec2.zero()` | `Vec2` | (0, 0) |
| `Vec2.unitX()` | `Vec2` | (1, 0) |
| `Vec2.unitY()` | `Vec2` | (0, 1) |
| `Vec2.fromArray([x, y])` | `Vec2` | From tuple |
| `Vec2.fromObject({x, y})` | `Vec2` | From plain object |

#### Static Operations

| Method | Returns | Description |
|--------|---------|-------------|
| `Vec2.add(a, b)` | `Vec2` | Vector addition |
| `Vec2.subtract(a, b)` | `Vec2` | Vector subtraction |
| `Vec2.multiply(v, scalar)` | `Vec2` | Scalar multiplication |
| `Vec2.divide(v, scalar)` | `Vec2` | Scalar division (throws on zero) |
| `Vec2.dot(a, b)` | `number` | Dot product |
| `Vec2.cross(a, b)` | `number` | Cross product (z-component) |
| `Vec2.distance(a, b)` | `number` | Euclidean distance |
| `Vec2.distanceSquared(a, b)` | `number` | Squared distance (avoid sqrt) |
| `Vec2.lerp(a, b, t)` | `Vec2` | Linear interpolation |
| `Vec2.min(a, b)` | `Vec2` | Component-wise minimum |
| `Vec2.max(a, b)` | `Vec2` | Component-wise maximum |
| `Vec2.negate(v)` | `Vec2` | Negate both components |

#### Instance Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `add(other)` | `Vec2` | Add vectors |
| `subtract(other)` | `Vec2` | Subtract vectors |
| `multiply(scalar)` | `Vec2` | Scale |
| `divide(scalar)` | `Vec2` | Divide |
| `dot(other)` | `number` | Dot product |
| `cross(other)` | `number` | Cross product |
| `negate()` | `Vec2` | Negate |
| `length()` | `number` | Magnitude |
| `lengthSquared()` | `number` | Squared magnitude |
| `normalize()` | `Vec2` | Unit vector (handles zero) |
| `rotate(angle)` | `Vec2` | Rotate by radians (CCW) |
| `rotateAround(center, angle)` | `Vec2` | Rotate around point |
| `lerp(other, t)` | `Vec2` | Interpolate |
| `distanceTo(other)` | `number` | Distance |
| `angle()` | `number` | Angle in radians (atan2) |
| `angleTo(other)` | `number` | Angle to other vector |
| `perpendicular()` | `Vec2` | 90° CCW rotation |
| `equals(other, epsilon?)` | `boolean` | Approximate equality |
| `clone()` | `Vec2` | Copy |
| `toArray()` | `[number, number]` | To tuple |
| `toObject()` | `{x, y}` | To plain object |

---

### Mat3 <Badge type="info" text="src/math/Mat3.ts" />

3x3 matrix for 2D affine transforms. Column-major order.

```
| a  c  e |   | m[0]  m[2]  m[4] |
| b  d  f | = | m[1]  m[3]  m[5] |
| 0  0  1 |   | 0     0     1    |
```

#### Static Factories

| Method | Returns | Description |
|--------|---------|-------------|
| `Mat3.identity()` | `Mat3` | Identity matrix |
| `Mat3.translation(tx, ty)` | `Mat3` | Translation matrix |
| `Mat3.translationVec(v)` | `Mat3` | Translation from Vec2 |
| `Mat3.rotation(angle)` | `Mat3` | Rotation (CCW radians) |
| `Mat3.rotationAt(angle, center)` | `Mat3` | Rotation around point |
| `Mat3.scale(s)` | `Mat3` | Uniform scale |
| `Mat3.scaleXY(sx, sy)` | `Mat3` | Non-uniform scale |
| `Mat3.scaleAt(sx, sy, center)` | `Mat3` | Scale around point |

#### Instance Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `multiply(other)` | `Mat3` | Matrix multiply (applies `other` first) |
| `preMultiply(other)` | `Mat3` | Applies `this` first |
| `transformPoint(point)` | `Vec2` | Transform point (includes translation) |
| `transformVector(vector)` | `Vec2` | Transform direction (ignores translation) |
| `inverse()` | `Mat3 \| null` | Inverse (null if singular) |
| `determinant()` | `number` | Matrix determinant |
| `translate(tx, ty)` | `Mat3` | Chain translation |
| `rotate(angle)` | `Mat3` | Chain rotation |
| `scale(s)` | `Mat3` | Chain uniform scale |
| `scaleXY(sx, sy)` | `Mat3` | Chain non-uniform scale |
| `applyToContext(ctx)` | `void` | Apply as canvas transform |
| `setOnContext(ctx)` | `void` | Set as canvas transform (replaces) |
| `isIdentity(epsilon?)` | `boolean` | Check if identity |
| `equals(other, epsilon?)` | `boolean` | Approximate equality |

::: tip
`a.multiply(b)` applies `b` first, then `a`. This matches standard matrix composition order — the rightmost transform is applied first.
:::

---

### Box <Badge type="info" text="src/math/Box.ts" />

Axis-Aligned Bounding Box (AABB). Immutable, auto-normalizes on construction.

#### Static Factories

| Method | Returns | Description |
|--------|---------|-------------|
| `Box.fromPoints(p1, p2)` | `Box` | From two corners |
| `Box.fromPointArray(points)` | `Box` | Enclosing box for point array |
| `Box.fromCenter(center, w, h)` | `Box` | From center and dimensions |
| `Box.fromPositionSize(pos, w, h)` | `Box` | From top-left and dimensions |
| `Box.empty()` | `Box` | Zero-size box at origin |
| `Box.infinite()` | `Box` | Infinite bounds |

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `minX`, `minY`, `maxX`, `maxY` | `number` | Boundary edges |
| `width`, `height` | `number` | Dimensions |
| `centerX`, `centerY` | `number` | Center coordinates |
| `center` | `Vec2` | Center as vector |
| `topLeft`, `topRight`, `bottomLeft`, `bottomRight` | `Vec2` | Corner points |
| `area` | `number` | Width × height |
| `perimeter` | `number` | 2 × (width + height) |
| `isEmpty` | `boolean` | Zero area |

#### Instance Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `containsPoint(point)` | `boolean` | Inclusive boundary |
| `containsPointStrict(point)` | `boolean` | Exclusive boundary |
| `containsBox(other)` | `boolean` | Fully contains other |
| `intersects(other)` | `boolean` | Overlaps (inclusive) |
| `intersectsStrict(other)` | `boolean` | Overlaps (exclusive) |
| `union(other)` | `Box` | Smallest enclosing box |
| `intersection(other)` | `Box` | Overlap region |
| `expandToInclude(point)` | `Box` | Grow to include point |
| `expand(amount)` | `Box` | Expand uniformly |
| `expandXY(amountX, amountY)` | `Box` | Expand per-axis |
| `shrink(amount)` | `Box` | Contract uniformly |
| `translate(offset)` | `Box` | Move by Vec2 |
| `scaleFromCenter(scale)` | `Box` | Scale from center |
| `clampPoint(point)` | `Vec2` | Nearest point inside |
| `distanceToPoint(point)` | `number` | 0 if inside |
| `getCorners()` | `[Vec2, Vec2, Vec2, Vec2]` | \[TL, TR, BR, BL\] |
| `toRBush()` | `{minX, minY, maxX, maxY}` | For spatial index |

---

### Geometry Functions <Badge type="info" text="src/math/geometry.ts" />

Standalone geometry helpers used throughout the engine.

#### Point-in-Shape Tests

| Function | Description |
|----------|-------------|
| `pointInRect(point, x, y, w, h)` | Axis-aligned rectangle |
| `pointInRotatedRect(point, x, y, w, h, rotation)` | Rotated rectangle |
| `pointInCircle(point, cx, cy, r)` | Circle |
| `pointInEllipse(point, cx, cy, rx, ry)` | Axis-aligned ellipse |
| `pointInRotatedEllipse(point, cx, cy, rx, ry, rotation)` | Rotated ellipse |

#### Line Intersection & Distance

| Function | Returns | Description |
|----------|---------|-------------|
| `lineIntersection(p1, p2, p3, p4)` | `LineIntersection` | Infinite line intersection |
| `segmentIntersection(p1, p2, p3, p4)` | `Vec2 \| null` | Line segment intersection |
| `distanceToLine(point, start, end)` | `number` | Distance to infinite line |
| `distanceToSegment(point, start, end)` | `number` | Distance to line segment |
| `closestPointOnSegment(point, start, end)` | `Vec2` | Nearest point on segment |
| `pointOnSegment(point, start, end, tol?)` | `boolean` | Is point on segment? |
| `boxIntersectsSegment(box, p1, p2)` | `boolean` | AABB vs line segment |

#### Angle & Rotation

| Function | Returns | Description |
|----------|---------|-------------|
| `angleBetween(v1, v2)` | `number` | \[0, π\] radians |
| `signedAngleBetween(v1, v2)` | `number` | \[-π, π\] (CCW positive) |
| `rotatedRectBounds(cx, cy, w, h, rot)` | `Box` | AABB of rotated rect |
| `normalizeAngle(angle)` | `number` | Normalize to \[-π, π\] |
| `degToRad(degrees)` | `number` | Degrees → radians |
| `radToDeg(radians)` | `number` | Radians → degrees |

#### Utility

| Function | Returns | Description |
|----------|---------|-------------|
| `lerp(a, b, t)` | `number` | Linear interpolation |
| `easeInOutCubic(t)` | `number` | Cubic easing for animations |
| `clamp(value, min, max)` | `number` | Clamp to range |
| `approxEqual(a, b, epsilon?)` | `boolean` | Float comparison (default ε=1e-10) |

---

## Color Utilities <Badge type="info" text="src/utils/color.ts" />

Color conversion and manipulation functions.

### Types

```typescript
interface RGB { r: number; g: number; b: number }     // 0-255
interface RGBA extends RGB { a: number }               // a: 0-1
interface HSL { h: number; s: number; l: number }      // h: 0-360, s/l: 0-100
```

### Functions

| Function | Returns | Description |
|----------|---------|-------------|
| `hexToRgb(hex)` | `RGB \| null` | Parse `#RGB`, `#RRGGBB`, `#RRGGBBAA` |
| `hexToRgba(hex)` | `RGBA \| null` | Parse with alpha channel |
| `rgbToHex(rgb)` | `string` | → `#RRGGBB` |
| `rgbaToHex(rgba)` | `string` | → `#RRGGBBAA` |
| `rgbToHsl(rgb)` | `HSL` | RGB → HSL conversion |
| `hslToRgb(hsl)` | `RGB` | HSL → RGB conversion |
| `lighten(hex, amount)` | `string` | Lighten by 0–100 |
| `darken(hex, amount)` | `string` | Darken by 0–100 |
| `isLightColor(hex)` | `boolean` | Uses relative luminance |
| `getContrastColor(bg)` | `string` | Returns `'#000000'` or `'#ffffff'` |

::: tip
Use `getContrastColor()` for text on colored backgrounds to ensure readability.
:::

---

## File Utilities <Badge type="info" text="src/utils/fileUtils.ts" />

File type detection, formatting, and validation helpers.

### Types

```typescript
type FileCategory = 'pdf' | 'spreadsheet' | 'image' | 'text' | 'generic';
```

### Functions

| Function | Returns | Description |
|----------|---------|-------------|
| `detectFileCategory(mimeType, fileName)` | `FileCategory` | Categorize for viewer selection |
| `getMimeType(fileName)` | `string` | Guess MIME from extension |
| `isPreviewableFile(mimeType)` | `boolean` | Has specialized viewer? |
| `getFileTypeIcon(category)` | `string` | Emoji icon for file type |
| `formatFileSize(bytes)` | `string` | `"1.5 MB"`, `"128 B"`, etc. |
| `validateFileForEmbed(file)` | `string \| null` | Error message or `null` if valid |
| `sanitizeFileName(name)` | `string` | Remove invalid chars, limit 200 |

### Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `MAX_EMBEDDED_FILE_SIZE` | `50 MB` | Maximum embedded file size |

---

## Export Utilities <Badge type="info" text="src/utils/exportUtils.ts" />

Canvas and SVG export for diagrams.

### Types

```typescript
interface ExportOptions {
  format: 'png' | 'svg';
  scope: 'all' | 'selection';
  scale: number;              // 1, 2, 3 for PNG
  background: string | null;  // hex or null for transparent
  padding: number;            // pixels
  filename: string;
  flattenGroups?: boolean;
  includeWhiteboard?: boolean;
}
```

### Functions

| Function | Returns | Description |
|----------|---------|-------------|
| `exportToPng(data, options)` | `Promise<Blob>` | Render to PNG blob |
| `exportToSvg(data, options)` | `string` | Generate SVG XML string |
| `getExportBounds(data, scope)` | `Box \| null` | Calculate export bounds |

::: tip
Group handling: If a group is explicitly selected, the entire group exports. If only some children are selected, only those children export without the group container.
:::

---

## Design Conventions

Key patterns used across all utility modules:

- **Immutability** — `Vec2`, `Mat3`, and `Box` all return new instances from every operation. Never mutate in place.
- **Tolerance** — Float comparisons use `epsilon = 1e-10` by default. Pass a custom epsilon when comparing values at different scales.
- **Angles** — All angles are in **radians**, counter-clockwise positive. Use `degToRad()` / `radToDeg()` for conversion.
- **Matrix multiplication** — `a.multiply(b)` applies `b` first, then `a`. This follows standard linear algebra convention.
- **Performance** — Use `lengthSquared()` / `distanceSquared()` to avoid `sqrt` when you only need relative comparisons (e.g., "is A closer than B?").
