/**
 * Describe a canvas `FileShape` for the file viewer (JP-495).
 *
 * This is where the canvas's *capabilities* get attached: replacing a file's
 * contents and recovering a missing blob both write back to the shape, so they
 * live here rather than in `fileDescriptor.ts` (which stays free of the services
 * layer). A host without these — prose — simply omits them, and the viewer hides
 * the affordances instead of offering an action that cannot work.
 */

import { useMemo } from 'react';

import { useDocumentStore } from '../store/documentStore';
import { replaceFileContents, reuploadMissingBlob } from '../services/FileReplaceService';
import { describeFileShape, type FileDescriptor } from './fileDescriptor';

/** `null` when the shape is absent or isn't a file — same contract as `useFileShape`. */
export function useFileShapeDescriptor(shapeId: string): FileDescriptor | null {
  const shape = useDocumentStore((state) => state.shapes[shapeId]);

  return useMemo(
    () =>
      describeFileShape(shape, {
        onReplace: async (file: File) => (await replaceFileContents(shapeId, file)).success,
        onRecover: async (file: File) => (await reuploadMissingBlob(shapeId, file)).success,
      }),
    [shape, shapeId],
  );
}
