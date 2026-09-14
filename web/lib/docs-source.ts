import { docs } from "@/.source/server";
import { loader } from "fumadocs-core/source";

/** Frontmatter fields the sidebar reads that are not part of Fumadocs' own page schema. */
interface SidebarOverride {
  sidebarTitle?: string;
}

export const docsSource = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
  pageTree: {
    transformers: [
      {
        // Some page titles are too long to sit in a 268px sidebar, so a page may carry a
        // shorter label for the tree without changing the heading on the page itself.
        file(node, filePath) {
          if (filePath === undefined) return node;
          const file = this.storage.read(filePath);
          if (file === undefined || file.format !== "page") return node;
          const label = (file.data as SidebarOverride).sidebarTitle;
          return label === undefined ? node : { ...node, name: label };
        },
      },
    ],
  },
});
