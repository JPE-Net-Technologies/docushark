import { describe, it, expect } from 'vitest';
import { Camera, MIN_ZOOM, MAX_ZOOM } from './Camera';
import { Vec2 } from '../math/Vec2';
import { Box } from '../math/Box';

describe('Camera', () => {
  describe('constructor and properties', () => {
    it('creates camera with default state', () => {
      const camera = new Camera();
      expect(camera.x).toBe(0);
      expect(camera.y).toBe(0);
      expect(camera.zoom).toBe(1);
    });

    it('creates camera with custom state', () => {
      const camera = new Camera({ x: 100, y: 200, zoom: 2 });
      expect(camera.x).toBe(100);
      expect(camera.y).toBe(200);
      expect(camera.zoom).toBe(2);
    });

    it('clamps zoom in constructor', () => {
      const cameraLow = new Camera({ zoom: 0.01 });
      expect(cameraLow.zoom).toBe(MIN_ZOOM);

      const cameraHigh = new Camera({ zoom: 100 });
      expect(cameraHigh.zoom).toBe(MAX_ZOOM);
    });

    it('state getter returns current state', () => {
      const camera = new Camera({ x: 10, y: 20, zoom: 1.5 });
      expect(camera.state).toEqual({ x: 10, y: 20, zoom: 1.5 });
    });
  });

  describe('setState', () => {
    it('updates all state properties', () => {
      const camera = new Camera();
      camera.setState({ x: 50, y: 75, zoom: 2.5 });
      expect(camera.x).toBe(50);
      expect(camera.y).toBe(75);
      expect(camera.zoom).toBe(2.5);
    });

    it('updates partial state', () => {
      const camera = new Camera({ x: 10, y: 20, zoom: 1 });
      camera.setState({ x: 100 });
      expect(camera.x).toBe(100);
      expect(camera.y).toBe(20);
      expect(camera.zoom).toBe(1);
    });

    it('clamps zoom when setting state', () => {
      const camera = new Camera();
      camera.setState({ zoom: 0.001 });
      expect(camera.zoom).toBe(MIN_ZOOM);
    });
  });

  describe('setViewport', () => {
    it('sets screen dimensions', () => {
      const camera = new Camera();
      camera.setViewport(1920, 1080);
      expect(camera.screenWidth).toBe(1920);
      expect(camera.screenHeight).toBe(1080);
    });
  });

  describe('screenToWorld', () => {
    it('converts screen center to world origin when camera at origin', () => {
      const camera = new Camera();
      camera.setViewport(800, 600);

      const worldPoint = camera.screenToWorld(new Vec2(400, 300));
      expect(worldPoint.x).toBeCloseTo(0);
      expect(worldPoint.y).toBeCloseTo(0);
    });

    it('converts screen corner to correct world position', () => {
      const camera = new Camera();
      camera.setViewport(800, 600);

      // Top-left corner (0, 0) should be at (-400, -300) in world
      const topLeft = camera.screenToWorld(new Vec2(0, 0));
      expect(topLeft.x).toBeCloseTo(-400);
      expect(topLeft.y).toBeCloseTo(-300);
    });

    it('accounts for camera position', () => {
      const camera = new Camera({ x: 100, y: 50 });
      camera.setViewport(800, 600);

      // Screen center should be at camera position
      const center = camera.screenToWorld(new Vec2(400, 300));
      expect(center.x).toBeCloseTo(100);
      expect(center.y).toBeCloseTo(50);
    });

    it('accounts for zoom', () => {
      const camera = new Camera({ zoom: 2 });
      camera.setViewport(800, 600);

      // With zoom 2, screen edges are closer in world space
      const topLeft = camera.screenToWorld(new Vec2(0, 0));
      expect(topLeft.x).toBeCloseTo(-200); // 400/2
      expect(topLeft.y).toBeCloseTo(-150); // 300/2
    });

    it('handles zoomed out view', () => {
      const camera = new Camera({ zoom: 0.5 });
      camera.setViewport(800, 600);

      // With zoom 0.5, screen edges are farther in world space
      const topLeft = camera.screenToWorld(new Vec2(0, 0));
      expect(topLeft.x).toBeCloseTo(-800); // 400/0.5
      expect(topLeft.y).toBeCloseTo(-600); // 300/0.5
    });
  });

  describe('worldToScreen', () => {
    it('converts world origin to screen center when camera at origin', () => {
      const camera = new Camera();
      camera.setViewport(800, 600);

      const screenPoint = camera.worldToScreen(new Vec2(0, 0));
      expect(screenPoint.x).toBeCloseTo(400);
      expect(screenPoint.y).toBeCloseTo(300);
    });

    it('accounts for camera position', () => {
      const camera = new Camera({ x: 100, y: 50 });
      camera.setViewport(800, 600);

      // Camera position should appear at screen center
      const cameraPos = camera.worldToScreen(new Vec2(100, 50));
      expect(cameraPos.x).toBeCloseTo(400);
      expect(cameraPos.y).toBeCloseTo(300);

      // World origin should be offset
      const origin = camera.worldToScreen(new Vec2(0, 0));
      expect(origin.x).toBeCloseTo(300); // 400 - 100
      expect(origin.y).toBeCloseTo(250); // 300 - 50
    });

    it('accounts for zoom', () => {
      const camera = new Camera({ zoom: 2 });
      camera.setViewport(800, 600);

      // World point at (100, 50) should be farther from center on screen
      const point = camera.worldToScreen(new Vec2(100, 50));
      expect(point.x).toBeCloseTo(600); // 400 + 100*2
      expect(point.y).toBeCloseTo(400); // 300 + 50*2
    });
  });

  describe('screenToWorld and worldToScreen roundtrip', () => {
    it('roundtrips screen -> world -> screen', () => {
      const camera = new Camera({ x: 50, y: -30, zoom: 1.5 });
      camera.setViewport(1024, 768);

      const screenPoint = new Vec2(250, 400);
      const worldPoint = camera.screenToWorld(screenPoint);
      const backToScreen = camera.worldToScreen(worldPoint);

      expect(backToScreen.x).toBeCloseTo(screenPoint.x);
      expect(backToScreen.y).toBeCloseTo(screenPoint.y);
    });

    it('roundtrips world -> screen -> world', () => {
      const camera = new Camera({ x: -100, y: 200, zoom: 0.8 });
      camera.setViewport(1280, 720);

      const worldPoint = new Vec2(500, -250);
      const screenPoint = camera.worldToScreen(worldPoint);
      const backToWorld = camera.screenToWorld(screenPoint);

      expect(backToWorld.x).toBeCloseTo(worldPoint.x);
      expect(backToWorld.y).toBeCloseTo(worldPoint.y);
    });
  });

  describe('getVisibleBounds', () => {
    it('returns correct bounds for camera at origin', () => {
      const camera = new Camera();
      camera.setViewport(800, 600);

      const bounds = camera.getVisibleBounds();
      expect(bounds.minX).toBeCloseTo(-400);
      expect(bounds.minY).toBeCloseTo(-300);
      expect(bounds.maxX).toBeCloseTo(400);
      expect(bounds.maxY).toBeCloseTo(300);
    });

    it('accounts for camera position', () => {
      const camera = new Camera({ x: 100, y: 50 });
      camera.setViewport(800, 600);

      const bounds = camera.getVisibleBounds();
      expect(bounds.minX).toBeCloseTo(-300);
      expect(bounds.minY).toBeCloseTo(-250);
      expect(bounds.maxX).toBeCloseTo(500);
      expect(bounds.maxY).toBeCloseTo(350);
    });

    it('accounts for zoom', () => {
      const camera = new Camera({ zoom: 2 });
      camera.setViewport(800, 600);

      const bounds = camera.getVisibleBounds();
      // With zoom 2, visible area is smaller
      expect(bounds.minX).toBeCloseTo(-200);
      expect(bounds.minY).toBeCloseTo(-150);
      expect(bounds.maxX).toBeCloseTo(200);
      expect(bounds.maxY).toBeCloseTo(150);
    });

    it('visible bounds dimensions match screen at zoom 1', () => {
      const camera = new Camera();
      camera.setViewport(800, 600);

      const bounds = camera.getVisibleBounds();
      expect(bounds.width).toBeCloseTo(800);
      expect(bounds.height).toBeCloseTo(600);
    });
  });

  describe('pan', () => {
    it('pans by screen delta', () => {
      const camera = new Camera();
      camera.setViewport(800, 600);

      // Pan right 100 pixels
      camera.pan(new Vec2(100, 0));
      // World moves left, so camera x decreases
      expect(camera.x).toBeCloseTo(-100);
    });

    it('accounts for zoom when panning', () => {
      const camera = new Camera({ zoom: 2 });
      camera.setViewport(800, 600);

      // Pan right 100 screen pixels at zoom 2
      camera.pan(new Vec2(100, 0));
      // World moves 50 units (100/2)
      expect(camera.x).toBeCloseTo(-50);
    });

    it('pans in both axes', () => {
      const camera = new Camera();
      camera.setViewport(800, 600);

      camera.pan(new Vec2(-50, 75));
      expect(camera.x).toBeCloseTo(50);
      expect(camera.y).toBeCloseTo(-75);
    });
  });

  describe('panWorld', () => {
    it('pans by world delta', () => {
      const camera = new Camera();
      camera.panWorld(new Vec2(100, 50));
      expect(camera.x).toBe(100);
      expect(camera.y).toBe(50);
    });

    it('is not affected by zoom', () => {
      const camera = new Camera({ zoom: 3 });
      camera.panWorld(new Vec2(100, 50));
      expect(camera.x).toBe(100);
      expect(camera.y).toBe(50);
    });
  });

  describe('zoomAt', () => {
    it('zooms in while keeping point stationary', () => {
      const camera = new Camera();
      camera.setViewport(800, 600);

      const screenPoint = new Vec2(600, 400);
      const worldBefore = camera.screenToWorld(screenPoint);

      camera.zoomAt(screenPoint, 2);

      const worldAfter = camera.screenToWorld(screenPoint);
      expect(worldAfter.x).toBeCloseTo(worldBefore.x);
      expect(worldAfter.y).toBeCloseTo(worldBefore.y);
    });

    it('zooms out while keeping point stationary', () => {
      const camera = new Camera({ zoom: 2 });
      camera.setViewport(800, 600);

      const screenPoint = new Vec2(200, 150);
      const worldBefore = camera.screenToWorld(screenPoint);

      camera.zoomAt(screenPoint, 0.5);

      const worldAfter = camera.screenToWorld(screenPoint);
      expect(worldAfter.x).toBeCloseTo(worldBefore.x);
      expect(worldAfter.y).toBeCloseTo(worldBefore.y);
    });

    it('zooms centered on screen center', () => {
      const camera = new Camera();
      camera.setViewport(800, 600);

      // Zoom at screen center
      camera.zoomAt(new Vec2(400, 300), 2);

      // Camera position should not change
      expect(camera.x).toBeCloseTo(0);
      expect(camera.y).toBeCloseTo(0);
      expect(camera.zoom).toBe(2);
    });

    it('clamps zoom to minimum', () => {
      const camera = new Camera({ zoom: 0.2 });
      camera.setViewport(800, 600);

      camera.zoomAt(new Vec2(400, 300), 0.1);
      expect(camera.zoom).toBe(MIN_ZOOM);
    });

    it('clamps zoom to maximum', () => {
      const camera = new Camera({ zoom: 8 });
      camera.setViewport(800, 600);

      camera.zoomAt(new Vec2(400, 300), 2);
      expect(camera.zoom).toBe(MAX_ZOOM);
    });
  });

  describe('smooth zoom interpolation', () => {
    it('setTargetZoom sets target', () => {
      const camera = new Camera();
      camera.setViewport(800, 600);

      camera.setTargetZoom(new Vec2(400, 300), 3);
      expect(camera.targetZoom).toBe(3);
    });

    it('setTargetZoom clamps target', () => {
      const camera = new Camera();
      camera.setViewport(800, 600);

      camera.setTargetZoom(new Vec2(400, 300), 100);
      expect(camera.targetZoom).toBe(MAX_ZOOM);
    });

    it('updateZoom interpolates toward target', () => {
      const camera = new Camera();
      camera.setViewport(800, 600);
      camera.setTargetZoom(new Vec2(400, 300), 2);

      const initialZoom = camera.zoom;
      camera.updateZoom(new Vec2(400, 300), 0.5);

      expect(camera.zoom).toBeGreaterThan(initialZoom);
      expect(camera.zoom).toBeLessThan(2);
    });

    it('updateZoom returns false when at target', () => {
      const camera = new Camera({ zoom: 2 });
      camera.setViewport(800, 600);
      camera.setTargetZoom(new Vec2(400, 300), 2);

      const stillAnimating = camera.updateZoom(new Vec2(400, 300));
      expect(stillAnimating).toBe(false);
    });

    it('updateZoom returns true when animating', () => {
      const camera = new Camera();
      camera.setViewport(800, 600);
      camera.setTargetZoom(new Vec2(400, 300), 5);

      const stillAnimating = camera.updateZoom(new Vec2(400, 300), 0.1);
      expect(stillAnimating).toBe(true);
    });
  });

  describe('zoomToFit', () => {
    it('centers on bounds', () => {
      const camera = new Camera();
      camera.setViewport(800, 600);

      const bounds = new Box(100, 200, 300, 400);
      camera.zoomToFit(bounds);

      expect(camera.x).toBeCloseTo(200); // center of [100, 300]
      expect(camera.y).toBeCloseTo(300); // center of [200, 400]
    });

    it('zooms to fit bounds with padding', () => {
      const camera = new Camera();
      camera.setViewport(800, 600);

      // Bounds 400x200 should fit comfortably with default 50px padding
      const bounds = new Box(0, 0, 400, 200);
      camera.zoomToFit(bounds);

      // Available space is 700x500 after padding
      // Zoom should be min(700/400, 500/200) = min(1.75, 2.5) = 1.75
      expect(camera.zoom).toBeCloseTo(1.75);
    });

    it('handles single point', () => {
      const camera = new Camera({ zoom: 0.5 });
      camera.setViewport(800, 600);

      const bounds = new Box(100, 100, 100, 100);
      camera.zoomToFit(bounds);

      expect(camera.x).toBeCloseTo(100);
      expect(camera.y).toBeCloseTo(100);
      // Zoom should remain unchanged for zero-size bounds
      expect(camera.zoom).toBe(0.5);
    });

    it('clamps zoom within bounds', () => {
      const camera = new Camera();
      camera.setViewport(800, 600);

      // Very small bounds that would require zoom > MAX_ZOOM
      const bounds = new Box(0, 0, 1, 1);
      camera.zoomToFit(bounds);

      expect(camera.zoom).toBe(MAX_ZOOM);
    });
  });

  describe('getTransformMatrix', () => {
    it('transforms world origin to screen center', () => {
      const camera = new Camera();
      camera.setViewport(800, 600);

      const matrix = camera.getTransformMatrix();
      const worldOrigin = new Vec2(0, 0);
      const screenPoint = matrix.transformPoint(worldOrigin);

      expect(screenPoint.x).toBeCloseTo(400);
      expect(screenPoint.y).toBeCloseTo(300);
    });

    it('accounts for camera position', () => {
      const camera = new Camera({ x: 100, y: 50 });
      camera.setViewport(800, 600);

      const matrix = camera.getTransformMatrix();

      // Camera position should appear at screen center
      const cameraPos = matrix.transformPoint(new Vec2(100, 50));
      expect(cameraPos.x).toBeCloseTo(400);
      expect(cameraPos.y).toBeCloseTo(300);
    });

    it('accounts for zoom', () => {
      const camera = new Camera({ zoom: 2 });
      camera.setViewport(800, 600);

      const matrix = camera.getTransformMatrix();

      // Point at (100, 0) should be 200 pixels right of center
      const point = matrix.transformPoint(new Vec2(100, 0));
      expect(point.x).toBeCloseTo(600); // 400 + 100*2
      expect(point.y).toBeCloseTo(300);
    });

    it('matches worldToScreen results', () => {
      const camera = new Camera({ x: -50, y: 100, zoom: 1.5 });
      camera.setViewport(1024, 768);

      const matrix = camera.getTransformMatrix();
      const testPoints = [
        new Vec2(0, 0),
        new Vec2(100, 200),
        new Vec2(-50, -100),
        new Vec2(300, -150),
      ];

      for (const worldPoint of testPoints) {
        const fromMethod = camera.worldToScreen(worldPoint);
        const fromMatrix = matrix.transformPoint(worldPoint);
        expect(fromMatrix.x).toBeCloseTo(fromMethod.x);
        expect(fromMatrix.y).toBeCloseTo(fromMethod.y);
      }
    });
  });

  describe('getInverseTransformMatrix', () => {
    it('transforms screen point to world point', () => {
      const camera = new Camera({ x: 100, y: 50, zoom: 2 });
      camera.setViewport(800, 600);

      const inverseMatrix = camera.getInverseTransformMatrix();
      expect(inverseMatrix).not.toBeNull();

      // Screen center should map to camera position
      const worldPoint = inverseMatrix!.transformPoint(new Vec2(400, 300));
      expect(worldPoint.x).toBeCloseTo(100);
      expect(worldPoint.y).toBeCloseTo(50);
    });

    it('matches screenToWorld results', () => {
      const camera = new Camera({ x: 30, y: -70, zoom: 0.8 });
      camera.setViewport(1280, 720);

      const inverseMatrix = camera.getInverseTransformMatrix();
      expect(inverseMatrix).not.toBeNull();

      const testPoints = [
        new Vec2(0, 0),
        new Vec2(640, 360),
        new Vec2(100, 500),
        new Vec2(1000, 200),
      ];

      for (const screenPoint of testPoints) {
        const fromMethod = camera.screenToWorld(screenPoint);
        const fromMatrix = inverseMatrix!.transformPoint(screenPoint);
        expect(fromMatrix.x).toBeCloseTo(fromMethod.x);
        expect(fromMatrix.y).toBeCloseTo(fromMethod.y);
      }
    });
  });

  describe('reset', () => {
    it('resets camera to default state', () => {
      const camera = new Camera({ x: 100, y: 200, zoom: 3 });
      camera.reset();

      expect(camera.x).toBe(0);
      expect(camera.y).toBe(0);
      expect(camera.zoom).toBe(1);
      expect(camera.targetZoom).toBe(1);
    });
  });

  describe('clone', () => {
    it('creates independent copy', () => {
      const camera = new Camera({ x: 100, y: 200, zoom: 2 });
      camera.setViewport(800, 600);

      const clone = camera.clone();

      expect(clone.x).toBe(100);
      expect(clone.y).toBe(200);
      expect(clone.zoom).toBe(2);
      expect(clone.screenWidth).toBe(800);
      expect(clone.screenHeight).toBe(600);

      // Modifications don't affect original
      clone.pan(new Vec2(100, 0));
      expect(camera.x).toBe(100);
    });
  });

  describe('zoom constraints', () => {
    it('MIN_ZOOM is 0.1', () => {
      expect(MIN_ZOOM).toBe(0.1);
    });

    it('MAX_ZOOM is 10', () => {
      expect(MAX_ZOOM).toBe(10);
    });

    it('cannot zoom below MIN_ZOOM', () => {
      const camera = new Camera();
      camera.setViewport(800, 600);

      // Try to zoom out to 0.01 (way below minimum)
      camera.zoomAt(new Vec2(400, 300), 0.01);
      expect(camera.zoom).toBe(MIN_ZOOM);
    });

    it('cannot zoom above MAX_ZOOM', () => {
      const camera = new Camera();
      camera.setViewport(800, 600);

      // Try to zoom in to 100 (way above maximum)
      camera.zoomAt(new Vec2(400, 300), 100);
      expect(camera.zoom).toBe(MAX_ZOOM);
    });
  });

  describe('edge cases', () => {
    it('handles viewport not set (zero dimensions)', () => {
      const camera = new Camera();
      // Don't call setViewport

      // screenToWorld should work (screen center is 0,0)
      const world = camera.screenToWorld(new Vec2(0, 0));
      expect(world.x).toBe(0);
      expect(world.y).toBe(0);

      // getVisibleBounds returns zero-size box at camera position
      const bounds = camera.getVisibleBounds();
      expect(bounds.width).toBe(0);
      expect(bounds.height).toBe(0);
      expect(bounds.center.x).toBe(0);
      expect(bounds.center.y).toBe(0);
    });

    it('pan works without viewport set', () => {
      const camera = new Camera();
      camera.pan(new Vec2(100, 50));
      expect(camera.x).toBe(-100);
      expect(camera.y).toBe(-50);
    });

    it('handles very small zoom values', () => {
      const camera = new Camera({ zoom: MIN_ZOOM });
      camera.setViewport(800, 600);

      // Should not cause division issues
      const world = camera.screenToWorld(new Vec2(400, 300));
      expect(Number.isFinite(world.x)).toBe(true);
      expect(Number.isFinite(world.y)).toBe(true);
    });

    it('handles large coordinate values', () => {
      const camera = new Camera({ x: 1e10, y: -1e10 });
      camera.setViewport(800, 600);

      const screen = camera.worldToScreen(new Vec2(1e10, -1e10));
      expect(screen.x).toBeCloseTo(400);
      expect(screen.y).toBeCloseTo(300);
    });

    it('zoomAt with factor of 1 does not change anything', () => {
      const camera = new Camera({ x: 100, y: 50, zoom: 2 });
      camera.setViewport(800, 600);

      camera.zoomAt(new Vec2(200, 150), 1);

      expect(camera.x).toBeCloseTo(100);
      expect(camera.y).toBeCloseTo(50);
      expect(camera.zoom).toBe(2);
    });
  });

  describe('eased zoom — setTargetZoom + updateZoom (JP-307 Slice 2)', () => {
    it('eases monotonically toward the target over multiple frames', () => {
      const camera = new Camera({ x: 0, y: 0, zoom: 1 });
      camera.setViewport(800, 600);
      const focal = new Vec2(200, 150);

      camera.setTargetZoom(focal, 3);
      expect(camera.targetZoom).toBe(3);

      let prev = camera.zoom;
      let ticks = 0;
      let animating = true;
      while (animating && ticks < 500) {
        animating = camera.updateZoom(focal, 0.2);
        // Approaches 3 from 1 without overshooting past the target.
        expect(camera.zoom).toBeGreaterThanOrEqual(prev);
        expect(camera.zoom).toBeLessThanOrEqual(3 + 1e-6);
        prev = camera.zoom;
        ticks += 1;
      }
      expect(camera.zoom).toBeCloseTo(3, 2);
      expect(ticks).toBeGreaterThan(1); // genuinely eased, not a single jump
    });

    it('keeps the focal world point stationary while easing', () => {
      const camera = new Camera({ x: 0, y: 0, zoom: 1 });
      camera.setViewport(800, 600);
      const focal = new Vec2(600, 400);
      const worldBefore = camera.screenToWorld(focal);

      camera.setTargetZoom(focal, 0.4);
      for (let i = 0; i < 500 && camera.updateZoom(focal, 0.2); i++) {
        /* settle */
      }

      const worldAfter = camera.screenToWorld(focal);
      expect(worldAfter.x).toBeCloseTo(worldBefore.x, 1);
      expect(worldAfter.y).toBeCloseTo(worldBefore.y, 1);
      expect(camera.zoom).toBeCloseTo(0.4, 2);
    });

    it('returns false immediately when already at the target', () => {
      const camera = new Camera({ zoom: 2 });
      camera.setViewport(800, 600);
      camera.setTargetZoom(new Vec2(400, 300), 2);
      expect(camera.updateZoom(new Vec2(400, 300))).toBe(false);
    });
  });
});
