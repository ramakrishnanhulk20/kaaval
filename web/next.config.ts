import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";

const here = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  // The account area compiles the engine's TypeScript from one folder up, so the root has
  // to be the folder that holds both the site and the engine, or nothing outside web/ can
  // be resolved at all.
  turbopack: { root: resolve(here, "..") },
  // On a host where only web/node_modules is installed, the engine files one folder up ask
  // for their packages by bare name and would be looked for beside themselves. This adds
  // the site's own packages as the last place to look, wherever the build runs. Last, not
  // first: a package that ships its own copy of a dependency has to keep winning, or the
  // hoisted copy at the top gets handed to a package that cannot use it.
  webpack: (config: { resolve: { modules?: string[] } }) => {
    const own = resolve(here, "node_modules");
    const existing = config.resolve.modules ?? ["node_modules"];
    config.resolve.modules = [...existing.filter((dir) => dir !== own), own];
    return config;
  },
  experimental: {
    // The account area compiles the engine's TypeScript, which lives outside the app.
    externalDir: true,
    // The engine imports its own files the way Node does, naming the .js each one compiles
    // to. This is what reads those specifiers as the .ts they are, and it is why dev and
    // build run on webpack: Turbopack has no equivalent in this version of Next.
    extensionAlias: { ".js": [".ts", ".tsx", ".js"] },
  },
  // Out of the bottom left corner, where the hero prints the last tick.
  devIndicators: { position: "bottom-right" },
  // A verification build must never write into the directory the dev server is serving from.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // The Bitget SDK is a Node package that reads the environment at call time, so it stays
  // out of the bundle and runs as a plain server dependency.
  serverExternalPackages: ["@bitget-ai/bitget-agent-sdk"],
  // The story used to live at its own address while Ram reviewed it. It is the front page
  // now, so the old link keeps working instead of dying.
  redirects: async () => [{ source: "/story", destination: "/", permanent: true }],
};

const withMDX = createMDX();

export default withMDX(nextConfig);
