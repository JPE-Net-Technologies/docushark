/**
 * PanelChromeWrapper — thin wrapper around a panel that captures right-click
 * (contextmenu) and shows `PanelChromeMenu` for Phase A's move/hide/pin
 * customization. Keeps PropertyPanel etc. unaware of the layout system.
 */

import { ReactNode, useCallback, useState } from 'react';
import { PanelChromeMenu } from './PanelChromeMenu';
import type { PanelId } from './types';

interface PanelChromeWrapperProps {
  panelId: PanelId;
  /** Optional class for the wrapper div (e.g. dock-side modifier). */
  className?: string;
  children: ReactNode;
}

export function PanelChromeWrapper({ panelId, className, children }: PanelChromeWrapperProps) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  }, []);

  return (
    <div className={className} onContextMenu={handleContextMenu} style={{ display: 'contents' }}>
      {children}
      {menu && (
        <PanelChromeMenu
          panelId={panelId}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
