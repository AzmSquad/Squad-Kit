import fs from 'node:fs';

/** The film shows on the site once its file is in public/film/; until then nothing points to it. */
export const filmFile = '/film/squad-kit-1.0.mp4';
export const hasFilm = fs.existsSync(new URL(`../../public${filmFile}`, import.meta.url));
