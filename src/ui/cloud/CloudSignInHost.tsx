/**
 * Portal host for the Cloud sign-in modal. Mount once at the app root (next to
 * <ConfirmDialogHost/>); it renders <CloudSignInModal/> into `document.body`
 * whenever `cloudSignInStore` is open, so the modal floats above any app view
 * (editor or Documents) without a view switch.
 */
import { createPortal } from 'react-dom';
import { useCloudSignInStore } from './cloudSignInStore';
import { CloudSignInModal } from './CloudSignInModal';

export function CloudSignInHost() {
  const isOpen = useCloudSignInStore((s) => s.isOpen);
  const close = useCloudSignInStore((s) => s.close);

  if (!isOpen || typeof document === 'undefined') return null;

  return createPortal(<CloudSignInModal onClose={close} />, document.body);
}

export default CloudSignInHost;
