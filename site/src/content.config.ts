import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const docs = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "../docs" }),
  schema: z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    /** Route segment for `/docs/[slug]`; set when the filename would normalize badly (e.g. `0.1` → `01`). */
    slug: z.string().optional(),
  }),
});

export const collections = { docs };
