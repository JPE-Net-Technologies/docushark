/**
 * MobilePreviewGate — the one-time opt-in to the experimental mobile layout
 * (JP-332). On a touch device at a narrow viewport, the first load offers the
 * (early, incomplete) mobile chrome behind a confirmation. Acceptance persists
 * (`mobilePreviewAccepted`) so the prompt fires at most once per browser;
 * "Not now" simply re-prompts on a future load.
 *
 * The *durable* opt-out ("use the desktop layout") lives in Settings →
 * Appearance, not in this dialog: `confirmDialog` collapses an explicit decline
 * and an Esc/backdrop dismissal into the same `false`, so the dialog only ever
 * commits on accept — declining is always non-committal.
 *
 * Renders nothing; it's an effect host mounted once at the app root (next to
 * `ConfirmDialogHost`, which actually draws the queued dialog).
 */

import { useEffect, useRef } from 'react';
import { confirmDialog } from '../confirm/confirmStore';
import { useMobileAdaptation } from '../layout/useMobileAdaptation';
import { useUIPreferencesStore } from '../../store/uiPreferencesStore';

export function MobilePreviewGate(): null {
  const { isMobile, accepted, forceDesktop } = useMobileAdaptation();
  const setMobilePreviewAccepted = useUIPreferencesStore((s) => s.setMobilePreviewAccepted);
  // Offer the prompt at most once per app session, even as the effect re-runs
  // on resize/orientation changes. Persisted flags handle suppression across
  // reloads; this ref handles it within a session.
  const promptedThisSession = useRef(false);

  useEffect(() => {
    if (!isMobile || accepted || forceDesktop) return;
    if (promptedThisSession.current) return;
    promptedThisSession.current = true;
    void (async () => {
      const ok = await confirmDialog({
        title: 'Mobile preview (experimental)',
        message:
          'The editor on a small screen is early-access and may be missing some features.',
        details: 'You can switch back to the desktop layout anytime in Settings → Appearance.',
        confirmLabel: 'Try mobile preview',
        cancelLabel: 'Not now',
      });
      if (ok) setMobilePreviewAccepted(true);
    })();
  }, [isMobile, accepted, forceDesktop, setMobilePreviewAccepted]);

  return null;
}
