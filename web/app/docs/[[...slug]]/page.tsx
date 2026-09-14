import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DocsBody, DocsPage, DocsTitle } from "fumadocs-ui/layouts/docs/page";
import { getMDXComponents } from "@/mdx-components";
import { docsSource } from "@/lib/docs-source";

interface Props {
  params: Promise<{ slug?: string[] }>;
}

export function generateStaticParams(): { slug?: string[] }[] {
  return docsSource.generateParams();
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const page = docsSource.getPage(slug);
  if (page === undefined) return {};
  return { title: page.data.title, description: page.data.description };
}

export default async function DocsContentPage({ params }: Props) {
  const { slug } = await params;
  const page = docsSource.getPage(slug);
  if (page === undefined) notFound();

  const MDX = page.data.body;

  return (
    <DocsPage toc={page.data.toc} full={false} tableOfContent={{ style: "clerk" }}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsBody>
        <MDX components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
}
