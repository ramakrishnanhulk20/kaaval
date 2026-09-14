import type { Metadata } from "next";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/next";
import { docsSource } from "@/lib/docs-source";

export const metadata: Metadata = {
  title: { default: "Kaaval documentation", template: "%s, Kaaval documentation" },
  description:
    "How Kaaval trades tokenized US stocks on Bitget through the night, and how to check its record yourself.",
};

export default function DocsRouteLayout({ children }: { children: React.ReactNode }) {
  return (
    <RootProvider
      theme={{ enabled: false }}
      search={{ options: { api: "/docs/api/search" } }}
    >
      <div className="kaaval-docs">
        <DocsLayout
          tree={docsSource.pageTree}
          nav={{ title: <Wordmark />, url: "/docs" }}
          links={[{ text: "Back to the record", url: "/", active: "none" }]}
          themeSwitch={{ enabled: false }}
          containerProps={{
            // The site's nav and ticker strip are fixed and 5rem tall together, so the docs
            // grid starts below them and every sticky column measures from the same line.
            style: { "--fd-banner-height": "5rem", paddingTop: "5rem" } as React.CSSProperties,
          }}
        >
          {children}
        </DocsLayout>
      </div>
    </RootProvider>
  );
}

function Wordmark() {
  return (
    <span className="font-mono text-[11px] uppercase tracking-[0.34em] text-ink">
      Kaaval <span className="text-amber">docs</span>
    </span>
  );
}
