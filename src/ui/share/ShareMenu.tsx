/**
 * ShareMenu — the top bar's Share button (DSK-257): share the open document
 * from where the writing is, instead of from Documents.
 *
 * Its items are the catalogue's `shareMenu` commands (`getShareMenuCommands`):
 * sharing with people first, then the files you can send. Like the canvas
 * menu, it keeps what can't run now in the list, greyed, and says why under
 * the people items, so sharing is never just missing.
 */

import { useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Share2 } from 'lucide-react';
import { getShareMenuCommands, recordRecent, type Command } from '../../engine/CommandRegistry';
import { SHARE_BLOCK_REASONS, shareBlock } from '../../services/shareActions';
import { Icon } from '../icons';
import '../components/RichSelect.css';
import './ShareMenu.css';

/** The items that share with people; the rest share a file. */
const PEOPLE = new Set(['share.people', 'share.publish']);

function ShareItem({ command }: { command: Command }) {
  const available = !command.canExecute || command.canExecute();
  return (
    <DropdownMenu.Item
      className="rich-select-item share-menu-item"
      disabled={!available}
      onSelect={() => {
        recordRecent(command.id);
        command.execute();
      }}
    >
      {command.icon && <Icon icon={command.icon} size={14} aria-hidden="true" />}
      <span>{command.label}</span>
    </DropdownMenu.Item>
  );
}

export function ShareMenu() {
  const [open, setOpen] = useState(false);
  // Read while open: availability rests on stores the toolbar doesn't follow.
  const commands = open ? getShareMenuCommands() : [];
  const people = commands.filter((c) => PEOPLE.has(c.id));
  const files = commands.filter((c) => !PEOPLE.has(c.id));
  const block = open ? shareBlock() : null;

  return (
    <DropdownMenu.Root modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="toolbar-menu-chip toolbar-share-btn" title="Share this document">
          <Icon icon={Share2} size={14} aria-hidden="true" />
          <span>Share</span>
          <span className="toolbar-tools-chevron" aria-hidden="true">▾</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="rich-select-content share-menu-content"
          side="bottom"
          align="end"
          sideOffset={4}
          collisionPadding={8}
        >
          {people.map((command) => (
            <ShareItem key={command.id} command={command} />
          ))}
          {block && (
            <p className="share-menu-reason" role="note">
              {SHARE_BLOCK_REASONS[block]}
            </p>
          )}
          {people.length > 0 && files.length > 0 && <DropdownMenu.Separator className="share-menu-separator" />}
          {files.map((command) => (
            <ShareItem key={command.id} command={command} />
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
