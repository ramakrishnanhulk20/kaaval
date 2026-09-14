import { remarkMdxMermaid } from "fumadocs-core/mdx-plugins/remark-mdx-mermaid";
import { defineConfig, defineDocs, frontmatterSchema } from "fumadocs-mdx/config";
import { z } from "zod";

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    schema: frontmatterSchema.extend({
      // The sidebar needs a short label where the page title runs long.
      sidebarTitle: z.string().optional(),
    }),
  },
});

export default defineConfig({
  mdxOptions: {
    // The architecture diagrams are mermaid fences; this turns them into a component
    // the browser can draw, because mermaid needs a DOM.
    remarkPlugins: (plugins) => [remarkMdxMermaid, ...plugins],
    rehypeCodeOptions: {
      themes: { light: "github-dark", dark: "github-dark" },
    },
  },
});
