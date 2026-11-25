import type { EpicPreview } from './requirements-types';

/** What Build all on an Epic or Feature would do, for its dialog (GET /api/v1/backlog/:id/build). */
export type { EpicPreview };

/** One story or bug a Build all would build, in the order it would build. */
export type EpicPreviewStory = EpicPreview['stories'][number];
